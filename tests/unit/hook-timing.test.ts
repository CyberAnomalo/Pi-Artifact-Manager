/**
 * Hook 时序回归测试 — allowedHashes 的清空点必须是 agent_end 而非 turn_end。
 *
 * 背景（真实 CLI 实测根因）：
 *   pi 的 turn_end 在工具循环内每个 provider 步后都触发（turnIndex++），
 *   若以 turn_end 清空 allowedHashes，artifact_get 加入的 hydration hash
 *   会在携带该图的下一请求发出之前被清掉 → guard 把 hydration 图剥离，
 *   模型看到 "Historical media blocked" 占位文本，恢复路径失效。
 *
 * 本测试用最小 fake ExtensionAPI 驱动真实入口函数，按真实事件时序重放：
 *   input(带图) → [请求1] → turn_end → artifact_get(allowHash) →
 *   turn_end → [请求2 含 hydration 图：必须放行] → agent_end →
 *   [请求3 同图：必须剥离]
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import artifactManagerExtension from "../../index.js";

let dir: string;
let prevCwd: string;
let hooks: Map<string, Array<(event: unknown, ctx: unknown) => Promise<unknown>>>;
let tools: Map<string, { name: string; execute: (toolCallId: string, params: Record<string, unknown>) => Promise<{ content: unknown[]; details: { artifactId?: string | null } }> }>;

const fakeCtx = { ui: { notify: () => {}, select: () => {}, confirm: () => {}, input: () => {} } };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-hooktiming-"));
  prevCwd = process.cwd();
  process.chdir(dir);

  hooks = new Map();
  tools = new Map();
  const fakePi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) {
      hooks.set(event, [...(hooks.get(event) ?? []), handler]);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool as never);
    },
    registerCommand: () => {},
  };
  artifactManagerExtension(fakePi as never);
});

afterEach(() => {
  const shutdown = hooks.get("session_shutdown")?.[0];
  process.chdir(prevCwd);
  void shutdown?.({}, fakeCtx).catch(() => {});
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {}
});

async function fire(event: string, payload: unknown): Promise<unknown> {
  let last: unknown;
  for (const handler of hooks.get(event) ?? []) {
    last = await handler(payload, fakeCtx);
  }
  return last;
}

/** 确定性假图片（≥512 base64 字符，满足 guard 的 looksLikeBase64）。 */
function fakeImage(seed: number): string {
  const buf = Buffer.alloc(2048);
  for (let i = 0; i < buf.length; i++) buf[i] = (seed + i * 31) & 0xff;
  return buf.toString("base64");
}

describe("allowedHashes 清空时序（hydration 回归）", () => {
  it("turn_end 不清空、agent_end 才清空：工具循环内 hydration 图必须放行", async () => {
    const base64 = fakeImage(901);

    // ── turn 1：用户带图输入 → ingest + allowHash ──
    await fire("input", { text: "看这张图", images: [{ type: "image", data: base64, mimeType: "image/png" }] });
    const req1 = (await fire("before_provider_request", {
      payload: { messages: [{ role: "user", content: [{ type: "image", data: base64, mimeType: "image/png" }] }] },
    })) as { blocked?: number } | undefined;
    expect(req1 === undefined || req1.blocked === 0).toBe(true); // 当前轮图片放行
    await fire("turn_end", { turnIndex: 0 });

    // ── turn 2：纯文本输入（清空），模型走工具循环取回图片 ──
    await fire("input", { text: "重新看上一张图" });

    // step 1：请求（纯文本）→ assistant 决定 artifact_get → turn_end
    await fire("before_provider_request", { payload: { messages: [{ role: "user", content: [{ type: "text", text: "..." }] }] } });
    await fire("turn_end", { turnIndex: 0 });

    // 工具执行：artifact_get → onReload → allowHash
    const getTool = tools.get("artifact_get");
    expect(getTool).toBeDefined();
    // 取真实 artifact id：通过 artifact_list 工具输出解析
    const listResult = (await tools.get("artifact_list")!.execute("call_0", {})) as {
      content: Array<{ type: string; text?: string }>;
    };
    const idMatch = JSON.stringify(listResult).match(/artifact_[0-9a-f]+/);
    expect(idMatch).not.toBeNull();
    const getResult = await getTool!.execute("call_1", { id: idMatch![0] });
    expect((getResult.details as { artifactId?: string }).artifactId).toBe(idMatch![0]);

    // ⚠ 回归核心：工具执行后、下一请求前 pi 会再发 turn_end —— 不得清空
    await fire("turn_end", { turnIndex: 1 });

    // step 2：携带 hydration 图的请求 —— 必须放行（blocked 为 0 / 返回 undefined）
    const hydratedPayload = {
      messages: [
        { role: "user", content: [{ type: "text", text: "重新看上一张图" }] },
        { role: "toolResult", content: [{ type: "image", data: base64, mimeType: "image/png" }] },
      ],
    };
    const req2 = (await fire("before_provider_request", { payload: hydratedPayload })) as { blocked?: number } | undefined;
    expect(req2 === undefined || req2.blocked === 0).toBe(true);

    // ── agent loop 结束 → 一切转历史 ──
    await fire("agent_end", { messages: [] });

    // turn 3：同一张图再次出现 = 历史媒体 —— 必须剥离
    // （hook 拦截时返回清理后的 payload；未拦截时返回 undefined）
    await fire("input", { text: "再看一次" });
    const req3 = await fire("before_provider_request", { payload: hydratedPayload });
    expect(req3).toBeDefined();
    expect(JSON.stringify(req3)).toContain("Historical media blocked");
  });
});
