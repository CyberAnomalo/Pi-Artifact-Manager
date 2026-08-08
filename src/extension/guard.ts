/**
 * Payload Guard — pi-artifact-manager 最重要的模块。
 *
 * 位置：before_provider_request（最后防线）。Fail-closed 安全边界。
 *
 * 确定性扫描目标（不依赖任何 provider 专属 SDK）：
 *   - data:image 前缀字符串
 *   - input_image 块
 *   - base64 图片数据块（pi/anthropic 风格 {type:"image", data}）
 *   - image_url 块（OpenAI 风格）
 *
 * 双模式：
 *   audit(payload)    — 严格检测：发现泄漏抛 HistoricalMediaLeakError（单测/对抗断言）
 *   sanitize(payload) — 生产剥离：媒体永远不进入 payload（pi runner 中抛错会被
 *                       捕获并继续发送原 payload，所以生产路径必须用剥离而非抛错）
 *
 * 规则（由 MediaPolicy 驱动）：
 *   - 普通文本轮：允许 0 image bytes（allowedHashes 为空 → 一切媒体剥离）
 *   - 当前轮 ingest / artifact_get 重载的 hash 在 allowedHashes 中 → 放行
 *   - 其余媒体节点 → 剥离并替换为文本占位（检测失败 = 禁止发送媒体）
 */

import type { ArtifactStore } from "../core/store.js";
import { sha256Base64 } from "../core/blob.js";
import { DEFAULT_MEDIA_POLICY, HistoricalMediaLeakError, type MediaPolicy } from "./policy.js";

export interface GuardResult {
  /** 清理后的 payload（blocked==0 时与输入结构相同） */
  payload: unknown;
  /** 被剥离的媒体块数量 */
  blocked: number;
  /** 被剥离的媒体原始字节数（解码后估算） */
  blockedBytes: number;
  /** 涉及的已知 artifact id（便于提示用户） */
  artifactRefs: string[];
}

/** 单次请求的媒体预算（确定性执行 policy.maxImages / maxMediaBytes）。 */
interface BudgetState {
  imagesLeft: number;
  bytesLeft: number;
}

/** 从 data URI 中提取 base64 部分。 */
function dataUriBase64(uri: string): string | null {
  const match = /^data:image\/[^;]+;base64,(.+)$/s.exec(uri);
  return match ? match[1] : null;
}

function looksLikeBase64(value: string): boolean {
  return value.length >= 512 && /^[A-Za-z0-9+/=\s]+$/.test(value.slice(0, 256));
}

function estimateBase64Bytes(value: string): number {
  return Math.floor((value.length * 3) / 4);
}

/**
 * 提取节点中可能的图片 base64（返回 null 表示该节点不是媒体）。
 * 覆盖多种 provider payload 形态。
 */
function extractImageBase64(node: Record<string, unknown>): string | null {
  const type = typeof node.type === "string" ? node.type : "";

  // pi / 通用：{ type: "image", data, mimeType }
  // anthropic：{ type: "image", source: { type: "base64", data } }
  if (type === "image" || type === "input_image") {
    if (typeof node.data === "string") return node.data;
    const source = node.source as Record<string, unknown> | undefined;
    if (source && typeof source.data === "string") return source.data;
    return ""; // 结构上就是图片块，但没有数据字段也按媒体处理
  }

  // openai：{ type: "image_url", image_url: { url } }
  if (type === "image_url") {
    const imageUrl = node.image_url as Record<string, unknown> | undefined;
    if (imageUrl && typeof imageUrl.url === "string") {
      const uri = imageUrl.url;
      return dataUriBase64(uri) ?? (uri.startsWith("http") ? "" : null);
    }
    return null;
  }

  // anthropic source 嵌套出现在无 type 的节点上
  const source = node.source as Record<string, unknown> | undefined;
  if (source && source.type === "base64" && typeof source.media_type === "string" && (source.media_type as string).startsWith("image/")) {
    return typeof source.data === "string" ? source.data : "";
  }

  return null;
}

/**
 * 深克隆「可克隆」的子树；遇到不可克隆节点（如 tools 里的 execute 函数）
 * 返回原引用。媒体只会出现在 messages 中，其余字段无需修改也无需克隆。
 * 不能用整包 structuredClone：真实 provider Context 含函数引用，
 * 会抛 DataCloneError —— 而钩子抛错会被 runner 吞掉并放行原 payload，
 * 导致 guard 静默 fail-open（E8 实测证实）。
 */
function cloneWalkable(node: unknown): unknown {
  try {
    return structuredClone(node);
  } catch {
    if (Array.isArray(node)) return node.map((child) => cloneWalkable(child));
    if (typeof node === "object" && node !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        out[key] = cloneWalkable(value);
      }
      return out;
    }
    return node;
  }
}

/**
 * PayloadGuard — 无状态扫描器 + 会话级 allowedHashes 视图。
 */
export class PayloadGuard {
  constructor(
    private readonly store: ArtifactStore,
    /** 当前轮允许的 blob hash 集合（ingest 时填充，轮结束清空） */
    private readonly allowedHashes: () => ReadonlySet<string>,
  ) {}

  /**
   * 严格检测（fail-closed 信号）：发现未授权媒体抛 HistoricalMediaLeakError。
   * 用于单元测试、对抗断言与未来可阻断请求的 harness adapter。
   */
  audit(payload: unknown, policy: MediaPolicy = DEFAULT_MEDIA_POLICY): void {
    const result = this.scanOnly(payload, policy);
    if (result.blocked > 0) {
      throw new HistoricalMediaLeakError(result.blocked, result.blockedBytes, result.artifactRefs);
    }
  }

  /**
   * 只扫描不修改：返回泄漏报告（audit / 测试观测用）。
   */
  scanOnly(payload: unknown, policy: MediaPolicy = DEFAULT_MEDIA_POLICY): GuardResult {
    const result: GuardResult = { payload, blocked: 0, blockedBytes: 0, artifactRefs: [] };
    if (payload === null || payload === undefined) return result;
    const allowed = this.allowedHashes();
    const budget: BudgetState = { imagesLeft: policy.maxImages, bytesLeft: policy.maxMediaBytes };
    this.walk(cloneWalkable(payload), allowed, result, policy, false, budget);
    return result;
  }

  /**
   * 清理 payload：剥离所有非授权的媒体节点（生产 fail-closed 路径）。
   * 纯函数式：先 structuredClone 再修改，不动原始 payload。
   */
  sanitize(payload: unknown, policy: MediaPolicy = DEFAULT_MEDIA_POLICY): GuardResult {
    const result: GuardResult = { payload, blocked: 0, blockedBytes: 0, artifactRefs: [] };
    if (payload === null || payload === undefined) return result;

    const allowed = this.allowedHashes();
    const budget: BudgetState = { imagesLeft: policy.maxImages, bytesLeft: policy.maxMediaBytes };
    const clone = cloneWalkable(payload);
    this.walk(clone, allowed, result, policy, true, budget);
    result.payload = clone;
    return result;
  }

  private walk(
    node: unknown,
    allowed: ReadonlySet<string>,
    result: GuardResult,
    policy: MediaPolicy,
    rewrite: boolean,
    budget: BudgetState,
  ): void {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        const replacement = rewrite ? this.replacementFor(child, allowed, result, policy, budget) : undefined;
        if (replacement !== undefined) {
          node[i] = replacement;
        } else {
          if (!rewrite) this.countIfMedia(child, allowed, result, policy, budget);
          this.walk(child, allowed, result, policy, rewrite, budget);
        }
      }
      return;
    }

    if (typeof node === "object" && node !== null) {
      const obj = node as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        // 纯字符串 data URI（如任意位置的 url 字段）
        if (typeof value === "string" && value.startsWith("data:image/")) {
          const b64 = dataUriBase64(value);
          const bytes = b64 ? estimateBase64Bytes(b64) : 0;
          if (b64 && this.isAllowed(b64, allowed, policy) && this.tryConsumeBudget(budget, bytes)) continue;
          this.recordBlock(bytes, result, undefined);
          if (rewrite) obj[key] = "[pi-artifact-manager: historical media blocked]";
          continue;
        }

        const replacement = rewrite ? this.replacementFor(value, allowed, result, policy, budget) : undefined;
        if (replacement !== undefined) {
          obj[key] = replacement;
        } else {
          if (!rewrite) this.countIfMedia(value, allowed, result, policy, budget);
          this.walk(value, allowed, result, policy, rewrite, budget);
        }
      }
    }
  }

  /** scan 模式：对媒体节点只计数不替换。 */
  private countIfMedia(
    node: unknown,
    allowed: ReadonlySet<string>,
    result: GuardResult,
    policy: MediaPolicy,
    budget: BudgetState,
  ): void {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const obj = node as Record<string, unknown>;
    const base64 = extractImageBase64(obj);
    if (base64 === null) return;
    const bytes = base64 ? estimateBase64Bytes(base64) : 0;
    if (base64 && this.isAllowed(base64, allowed, policy) && this.tryConsumeBudget(budget, bytes)) return;
    const known = base64 ? this.store.findByHash(sha256Base64(base64)) : undefined;
    this.recordBlock(bytes, result, known?.id);
  }

  /** 若 node 是媒体节点则返回替换文本节点；否则返回 undefined。 */
  private replacementFor(
    node: unknown,
    allowed: ReadonlySet<string>,
    result: GuardResult,
    policy: MediaPolicy,
    budget: BudgetState,
  ): unknown {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;

    const obj = node as Record<string, unknown>;
    const base64 = extractImageBase64(obj);
    if (base64 === null) return undefined;

    const bytes = base64 ? estimateBase64Bytes(base64) : 0;

    // 授权集合内且策略允许且预算充足 → 放行（消耗预算）
    if (base64 && this.isAllowed(base64, allowed, policy) && this.tryConsumeBudget(budget, bytes)) {
      return undefined;
    }

    // 若该图片是已知 artifact，替换文本带上引用信息
    const known = base64 ? this.store.findByHash(sha256Base64(base64)) : undefined;
    this.recordBlock(bytes, result, known?.id);

    const refPart = known ? ` (artifact: ${known.id})` : "";

    return {
      type: "text",
      text: `[pi-artifact-manager] Historical media blocked${refPart}; ${bytes} bytes removed. Use artifact_get to reload it into the current turn.`,
    };
  }

  /**
   * 预算消耗（确定性执行 policy.maxImages / maxMediaBytes）。
   * 授权媒体的累计量超出上限时，超出部分同样视为泄漏 —— fail-closed。
   */
  private tryConsumeBudget(budget: BudgetState, bytes: number): boolean {
    if (budget.imagesLeft <= 0) return false;
    if (budget.bytesLeft < bytes) return false;
    budget.imagesLeft -= 1;
    budget.bytesLeft -= bytes;
    return true;
  }

  private isAllowed(base64: string, allowed: ReadonlySet<string>, policy: MediaPolicy): boolean {
    if (!policy.allowCurrentTurnMedia && !policy.allowArtifactHydration) return false;
    if (allowed.size === 0) return false; // 普通文本轮：允许 0 image bytes
    if (!looksLikeBase64(base64)) return false;
    return allowed.has(sha256Base64(base64));
  }

  private recordBlock(bytes: number, result: GuardResult, artifactId: string | undefined): void {
    result.blocked += 1;
    result.blockedBytes += bytes;
    if (artifactId) result.artifactRefs.push(artifactId);
    this.store.blockedHistoricalMediaBytes += bytes;
  }
}
