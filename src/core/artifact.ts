/**
 * Artifact 核心类型定义。
 *
 * Artifact ID 设计（MVP）：
 *   - 不做复杂 semantic path（如 homepage/desktop/default/main@r12），
 *     因为早期无法可靠生成。
 *   - 使用 `artifact_<short_hash>`，例如 `artifact_a83fd91`。
 *   - 展示名 `Artifact #N` 由序号生成（按 created_at 排序）。
 *
 * PLACEHOLDER（未来字段）:
 *   semantic_key, revision, branch
 */

import type { ArtifactStatus } from "./lifecycle.js";

export interface Artifact {
  /** `artifact_<short_hash>` */
  id: string;
  /** sha256 hex of blob content */
  blobHash: string;
  mimeType: string | null;
  byteSize: number;
  /** PLACEHOLDER: 语义摘要，MVP 为 null 或人工填写 */
  summary: string | null;
  /** 'user-input' | 'tool-result' | 'unknown' */
  source: string;
  status: ArtifactStatus;
  /** unix ms */
  createdAt: number;
  // PLACEHOLDER: 未来扩展字段
  // semanticKey?: string;
  // revision?: number;
  // branch?: string;
}

export interface BlobRecord {
  hash: string;
  /** 相对 .visual-artifacts/ 的路径 */
  path: string;
  size: number;
  createdAt: number;
}

/** 生成 artifact id：artifact_<hash 前 7 位> */
export function makeArtifactId(sha256Hex: string): string {
  return `artifact_${sha256Hex.slice(0, 7)}`;
}

/** 校验 artifact id 格式（确定性校验，拒绝非法输入）。 */
export function isValidArtifactId(id: string): boolean {
  return /^artifact_[0-9a-f]{7,64}$/.test(id);
}
