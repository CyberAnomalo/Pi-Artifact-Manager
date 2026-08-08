/**
 * Pi Extension Hooks — 把 Core 接到 Pi coding-agent 的事件总线上。
 *
 * 钩子布局（设计文档 §11）：
 *   input                    — 捕获用户图片 → artifact_ingest()（当前轮允许）
 *   context                  — 历史图片替换为 artifact 引用
 *   before_provider_request  — Payload Guard，最后防线
 *   session_before_compact   — 压缩前检查 media bytes == 0
 *   session_start            — 恢复 session_id + active artifact 状态
 *   agent_end                — 清空当前轮 allowedHashes（一切转历史）
 *                              注意：不能用 turn_end —— pi 在工具循环内每个
 *                              provider 步后都触发 turn_end，会在 artifact_get
 *                              之后、下一请求之前把 hydration hash 清掉
 *   session_shutdown         — 关闭数据库
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ArtifactStore } from "../core/store.js";
import { PayloadGuard } from "./guard.js";
import { transformContext, type AgentMessageLike } from "./context.js";
import type { RuntimeCounters } from "../tools/stats.js";

/** 扩展运行时状态（会话级）。 */
export interface ExtensionState {
  store: ArtifactStore;
  guard: PayloadGuard;
  counters: RuntimeCounters;
  /** 当前轮允许进入 provider 的 blob hash 集合 */
  currentTurnAllowedHashes: Set<string>;
  /** 当前 session id（session_start 时写入） */
  sessionId: string | null;
}

export function createState(store: ArtifactStore): ExtensionState {
  const state: ExtensionState = {
    store,
    guard: undefined as unknown as PayloadGuard, // 下一行延迟绑定
    counters: { contextRemovedMediaBytes: 0, guardBlockedMediaBytes: 0 },
    currentTurnAllowedHashes: new Set(),
    sessionId: null,
  };
  // guard 通过闭包读取当前允许集合（clear/add 均作用于同一 Set）
  state.guard = new PayloadGuard(store, () => state.currentTurnAllowedHashes);
  return state;
}

/** 供 tools/artifact_get 回调：把重载的 blob hash 加入当前轮允许集合。 */
export function allowHash(state: ExtensionState, blobHash: string): void {
  state.currentTurnAllowedHashes.add(blobHash);
}

const safeNotify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
  try {
    ctx.ui.notify(message, type);
  } catch {
    // ctx 可能在 session 切换后 stale；通知失败不影响主流程
  }
};

export function registerHooks(pi: ExtensionAPI, state: ExtensionState): void {
  const { store } = state;

  // context 事件的 ContextEventResult 未在 pi-coding-agent dist 导出，返回值用 any 断言

  // ── input：捕获用户图片 → ingest ────────────────────────────────
  pi.on("input", async (event, _ctx) => {
    const images = (event as { images?: { type: string; data: string; mimeType: string }[] }).images;
    if (!images || images.length === 0) {
      // 纯文本轮：清空允许集合（普通文本轮允许 0 image bytes）
      state.currentTurnAllowedHashes.clear();
      return { action: "continue" } as const;
    }
    for (const image of images) {
      if (image.type !== "image" || typeof image.data !== "string") continue;
      const result = store.ingest({
        data: Buffer.from(image.data, "base64"),
        mimeType: image.mimeType ?? null,
        source: "user-input",
      });
      allowHash(state, result.blobHash);
    }
    // 保留图片：当前轮允许发送一次（image allowed once）
    return { action: "continue" } as const;
  });

  // ── context：历史图片 → artifact 引用 ───────────────────────────
  pi.on("context", async (event, _ctx) => {
    const messages = (event as unknown as { messages: AgentMessageLike[] }).messages;
    if (!Array.isArray(messages)) return;
    const result = transformContext(messages, store);

    // 当前轮媒体授权（image allowed once）：补齐 toolResult 图片等
    // input 钩子覆盖不到的路径，否则 guard 会将其当历史媒体剥离
    for (const hash of result.currentTurnMediaHashes) {
      allowHash(state, hash);
    }

    if (result.replacedCount === 0) return;

    state.counters.contextRemovedMediaBytes += result.removedMediaBytes;

    // 持久化当前会话的 active artifact 列表
    if (state.sessionId) {
      store.recordSession(state.sessionId, result.artifactIds);
    }
    // biome-ignore lint/suspicious/noExplicitAny: ContextEventResult 未导出
    return { messages: result.messages } as any;
  });

  // ── before_provider_request：Payload Guard 最后防线 ─────────────
  pi.on("before_provider_request", async (event, ctx) => {
    const payload = (event as { payload: unknown }).payload;
    const result = state.guard.sanitize(payload);
    if (result.blocked === 0) return; // 干净 payload，原样放行

    state.counters.guardBlockedMediaBytes += result.blockedBytes;
    safeNotify(
      ctx,
      `[pi-artifact-manager] blocked ${result.blocked} historical media block(s), ${result.blockedBytes} bytes kept out of provider request`,
      "warning",
    );
    // 检测失败 = 禁止发送媒体：返回剥离后的 payload
    return result.payload;
  });

  // ── session_before_compact：压缩时 media bytes 必须为 0 ─────────
  pi.on("session_before_compact", async (event, ctx) => {
    const entries = (event as { branchEntries?: unknown[] }).branchEntries ?? [];
    let mediaBytes = 0;
    let mediaBlocks = 0;
    const scan = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) scan(child);
        return;
      }
      if (typeof node === "object" && node !== null) {
        const obj = node as Record<string, unknown>;
        if (obj.type === "image" && typeof obj.data === "string") {
          mediaBlocks += 1;
          mediaBytes += Math.floor(((obj.data as string).length * 3) / 4);
          return;
        }
        for (const value of Object.values(obj)) scan(value);
      }
    };
    scan(entries);

    if (mediaBytes > 0) {
      // MVP：告警 + 记录；PLACEHOLDER: 未来可在此改写 compaction 输入
      safeNotify(
        ctx,
        `[pi-artifact-manager] warning: compaction input contains ${mediaBlocks} media block(s), ~${mediaBytes} bytes`,
        "warning",
      );
    }
    // 不取消压缩（cancel 会破坏上下文管理）；context hook 已保证默认路径干净
    return;
  });

  // ── session_start：恢复 session_id + active artifact 状态 ───────
  pi.on("session_start", async (_event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      state.sessionId = sessionId;
      const activeIds = store.getSessionArtifacts(sessionId);
      if (activeIds.length > 0) {
        // PLACEHOLDER: 未来在此预热 active artifact 索引 / 缓存
        safeNotify(ctx, `[pi-artifact-manager] session restored: ${activeIds.length} artifact ref(s) known`);
      }
    } catch {
      // sessionManager 尚未就绪时静默跳过
    }
  });

  // ── agent_end：agent loop（整个用户轮）结束 → 一切媒体转历史 ────
  // 不能用 turn_end：pi 在工具循环内每个 provider 步后都触发 turn_end，
  // 会在 artifact_get 加入 hash 之后、携带 hydration 图的请求发出之前清空集合
  // （真实 CLI 实测：hydration 图被 guard 剥离，模型看到 blocked 占位文本）。
  pi.on("agent_end", async () => {
    state.currentTurnAllowedHashes.clear();
  });

  // ── session_shutdown：关闭数据库 ────────────────────────────────
  pi.on("session_shutdown", async () => {
    try {
      store.close();
    } catch {
      // 重复 close 无害
    }
  });
}
