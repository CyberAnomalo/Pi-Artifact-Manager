/**
 * Artifact lifecycle state machine (MVP 简化版).
 *
 * 状态流转（确定性，无 LLM 参与）：
 *
 *   CREATED → ACTIVE → CONSUMED → ARCHIVED
 *
 * - CREATED:  刚保存（ingest 写入瞬间；MVP 中通常直接落到 ACTIVE）
 * - ACTIVE:   当前轮允许发送给模型
 * - CONSUMED: 模型已经看过；下一轮上下文中只保留 artifact_id + summary
 * - ARCHIVED: 不进入默认查询
 *
 * PLACEHOLDER（未来状态，明确不实现）:
 *   COOLED     — 冷存储分级
 *   REHYDRATED — 从冷存储恢复后的临时状态
 *   REFERENCE  — 纯引用态（无 blob 保留）
 */

export type ArtifactStatus = "created" | "active" | "consumed" | "archived";

/** MVP 合法状态集合（用于 DB 写入前校验，防止非法状态泄漏）。 */
export const MVP_STATUSES: readonly ArtifactStatus[] = ["created", "active", "consumed", "archived"];

/** 允许的迁移：from → to。 */
const TRANSITIONS: Record<ArtifactStatus, readonly ArtifactStatus[]> = {
  created: ["active", "archived"],
  active: ["consumed", "archived"],
  consumed: ["active", "archived"], // active: artifact_get 显式重载后允许再次进入当前轮
  archived: [], // 终态；未来 REHYDRATED 时放开
};

export function canTransition(from: ArtifactStatus, to: ArtifactStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * 校验并返回目标状态；非法迁移抛出异常（fail fast，确定性优先）。
 */
export function assertTransition(from: ArtifactStatus, to: ArtifactStatus): ArtifactStatus {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal artifact lifecycle transition: ${from} -> ${to}`);
  }
  return to;
}

export function isStatus(value: string): value is ArtifactStatus {
  return (MVP_STATUSES as readonly string[]).includes(value);
}
