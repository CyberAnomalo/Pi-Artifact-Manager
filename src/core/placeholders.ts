/**
 * PLACEHOLDER 模块 — 明确不实现，仅保留接口与设计位。
 *
 * 设计原则："所有未实现功能保留接口和 placeholder"。
 * 这里的每个接口都对应设计文档 §13「不做内容」中的一条。
 * 实现时直接抛错（fail fast），防止误用。
 */

import type { Artifact } from "./artifact.js";

// ---------------------------------------------------------------------------
// ❌ 自动语义分类（早期收益低，不依赖 LLM 分类才能工作）
// ---------------------------------------------------------------------------

export interface SemanticClassifier {
  /** 为 artifact 生成语义摘要/分类。MVP 不实现。 */
  classify(artifact: Artifact): Promise<{ summary: string; tags: string[] }>;
}

export class UnimplementedSemanticClassifier implements SemanticClassifier {
  async classify(_artifact: Artifact): Promise<{ summary: string; tags: string[] }> {
    throw new Error("PLACEHOLDER: SemanticClassifier is not implemented in MVP (no LLM dependency)");
  }
}

// ---------------------------------------------------------------------------
// ❌ Revision DAG
// ---------------------------------------------------------------------------

export interface RevisionManager {
  createRevision(artifactId: string, newData: Buffer): Promise<string>;
  getRevisionHistory(artifactId: string): Promise<unknown[]>;
}

export class UnimplementedRevisionManager implements RevisionManager {
  async createRevision(_artifactId: string, _newData: Buffer): Promise<string> {
    throw new Error("PLACEHOLDER: RevisionManager (artifact_revisions) is not implemented in MVP");
  }
  async getRevisionHistory(_artifactId: string): Promise<unknown[]> {
    throw new Error("PLACEHOLDER: RevisionManager is not implemented in MVP");
  }
}

// ---------------------------------------------------------------------------
// ❌ Branch
// ---------------------------------------------------------------------------

export interface ArtifactBranchService {
  createBranch(artifactId: string, branchName: string): Promise<string>;
  listBranches(artifactId: string): Promise<string[]>;
}

export class UnimplementedArtifactBranchService implements ArtifactBranchService {
  async createBranch(_artifactId: string, _branchName: string): Promise<string> {
    throw new Error("PLACEHOLDER: ArtifactBranchService (artifact_branches) is not implemented in MVP");
  }
  async listBranches(_artifactId: string): Promise<string[]> {
    throw new Error("PLACEHOLDER: ArtifactBranchService is not implemented in MVP");
  }
}

// ---------------------------------------------------------------------------
// ❌ 图片 Diff
// ---------------------------------------------------------------------------

export interface ArtifactComparator {
  compare(a: Artifact, b: Artifact): Promise<{ diffSummary: string; changedRegions: unknown[] }>;
}

export class UnimplementedArtifactComparator implements ArtifactComparator {
  async compare(_a: Artifact, _b: Artifact): Promise<{ diffSummary: string; changedRegions: unknown[] }> {
    throw new Error("PLACEHOLDER: ArtifactComparator (image diff) is not implemented in MVP");
  }
}

// ---------------------------------------------------------------------------
// ❌ 多模型适配（第一版只支持 Pi）
// ---------------------------------------------------------------------------

/**
 * Adapter interface — 未来支持 Codex / OpenCode 等 harness。
 * MVP 只有 PiAdapter（由 extension/ 层直接实现，不经此接口）。
 */
export interface HarnessAdapter {
  readonly name: string;
  /** 将 adapter 绑定到具体 harness 的运行时。 */
  attach(runtime: unknown): void;
}

/** PLACEHOLDER: 未来实现 */
export class CodexAdapter implements HarnessAdapter {
  readonly name = "codex";
  attach(_runtime: unknown): void {
    throw new Error("PLACEHOLDER: CodexAdapter is not implemented (MVP supports Pi only)");
  }
}

/** PLACEHOLDER: 未来实现 */
export class OpenCodeAdapter implements HarnessAdapter {
  readonly name = "opencode";
  attach(_runtime: unknown): void {
    throw new Error("PLACEHOLDER: OpenCodeAdapter is not implemented (MVP supports Pi only)");
  }
}

// ---------------------------------------------------------------------------
// ❌ 独立 Sidecar（第一版：插件内部；未来：artifact-core daemon）
// ---------------------------------------------------------------------------

export interface ArtifactCoreDaemon {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class UnimplementedArtifactCoreDaemon implements ArtifactCoreDaemon {
  async start(): Promise<void> {
    throw new Error("PLACEHOLDER: artifact-core daemon is not implemented in MVP (runs in-process)");
  }
  async stop(): Promise<void> {
    throw new Error("PLACEHOLDER: artifact-core daemon is not implemented in MVP");
  }
}
