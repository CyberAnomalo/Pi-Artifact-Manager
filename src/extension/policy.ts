/**
 * Request Media Policy — 每次 provider request 前生效的媒体准入策略。
 *
 * 解决的核心定义问题：「什么叫当前轮？」
 *
 *   Turn boundary（当前轮边界）:
 *     从最后一个 user message 开始，到 agent_end 事件（agent loop 结束）为止。
 *     一个用户轮内部可能包含：多个 agent step（pi 的 turn_end 在
 *     工具循环内每步后都会触发，不能作为清空点）、provider retry、
 *     多次 before_provider_request —— 它们都属于同一个轮。
 *     allowedHashes 集合只在 agent_end 清空，因此 retry 与工具循环
 *     不会把当前轮的合法图片误判为历史媒体（fail-closed 但不过度拦截）。
 *
 * 策略语义：
 *   allowCurrentTurnMedia   — 当前 turn ingest 的图片允许进入 payload
 *   allowArtifactHydration  — artifact_get 显式重载的图片允许进入 payload
 *   maxMediaBytes           — 单次请求允许的媒体字节上限（超出视为泄漏）
 *   maxImages               — 单次请求允许的图片块数量上限
 *
 * PLACEHOLDER（未来策略扩展）:
 *   cooldownTurns            — 图片在 N 轮后强制归档
 *   perProviderOverrides     — 按 provider 差异化策略
 */

export interface MediaPolicy {
  /** 当前 turn ingest 的媒体是否允许（默认 true = image allowed once） */
  allowCurrentTurnMedia: boolean;
  /** artifact_get 显式重载的媒体是否允许 */
  allowArtifactHydration: boolean;
  /** 单次 provider request 允许的媒体字节上限（解码后） */
  maxMediaBytes: number;
  /** 单次 provider request 允许的图片块数量 */
  maxImages: number;
}

/** MVP 默认策略：当前轮允许一次，无硬上限（由生命周期管理保证 O(1)）。 */
export const DEFAULT_MEDIA_POLICY: MediaPolicy = {
  allowCurrentTurnMedia: true,
  allowArtifactHydration: true,
  maxMediaBytes: Number.POSITIVE_INFINITY,
  maxImages: Number.POSITIVE_INFINITY,
};

/** 严格策略：0 媒体容忍（用于测试断言与对抗场景）。 */
export const ZERO_MEDIA_POLICY: MediaPolicy = {
  allowCurrentTurnMedia: false,
  allowArtifactHydration: false,
  maxMediaBytes: 0,
  maxImages: 0,
};

/**
 * guard 检测到历史媒体泄漏时抛出的错误（fail-closed 信号）。
 *
 * 注意 pi runner 行为：before_provider_request 中抛错会被捕获并继续
 * 发送原始 payload（等于 fail-open）。因此生产路径使用 sanitize() 剥离，
 * 本错误用于：(1) audit() 严格检测（单元测试 / 对抗断言），
 * (2) 未来 harness adapter 支持真正阻断请求时的钩子。
 */
export class HistoricalMediaLeakError extends Error {
  /** 检测到的媒体块数量 */
  readonly leakCount: number;
  /** 泄漏媒体字节（解码后估算） */
  readonly leakBytes: number;
  /** 已知的 artifact id（便于定位） */
  readonly artifactRefs: string[];

  constructor(leakCount: number, leakBytes: number, artifactRefs: string[]) {
    super(
      `Historical media leak detected: ${leakCount} block(s), ~${leakBytes} bytes` +
        (artifactRefs.length > 0 ? ` (artifacts: ${artifactRefs.join(", ")})` : ""),
    );
    this.name = "HistoricalMediaLeakError";
    this.leakCount = leakCount;
    this.leakBytes = leakBytes;
    this.artifactRefs = artifactRefs;
  }
}
