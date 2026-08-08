/**
 * ArtifactStore — Core 门面，组合 BlobStore + Database。
 *
 * 确定性 ingest 流程（无 LLM 参与）：
 *   1. calculate hash (sha256)
 *   2. save blob（去重）
 *   3. create metadata
 *   4. return artifact id
 *
 * Core 不依赖 Pi，可独立测试。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Artifact } from "./artifact.js";
import { makeArtifactId } from "./artifact.js";
import { BlobStore, sha256Hex } from "./blob.js";
import { Database } from "./database.js";
import { assertTransition, isStatus, type ArtifactStatus } from "./lifecycle.js";

export const STORAGE_DIR_NAME = ".visual-artifacts";

export interface IngestInput {
  /** 图片二进制 */
  data: Buffer;
  mimeType: string | null;
  /** 'user-input' | 'tool-result' | 'unknown' */
  source: string;
  /** PLACEHOLDER: 未来由 SemanticClassifier 提供 */
  summary?: string | null;
}

export interface IngestResult {
  artifactId: string;
  blobHash: string;
  byteSize: number;
  /** true 表示 blob 已存在（去重命中） */
  deduplicated: boolean;
  /** true 表示 artifact 记录已存在（同 hash 之前已入库） */
  existing: boolean;
}

export interface ArtifactStats {
  artifactCount: number;
  blobCount: number;
  storageBytes: number;
  /** 历史媒体字节（上下文中的）；由 extension 层上报，core 侧恒为 0 统计入口 */
  historicalMediaBytes: number;
}

export class ArtifactStore {
  readonly root: string;
  readonly blobStore: BlobStore;
  readonly db: Database;

  /** 历史媒体字节计数（guard 剥离时累加，benchmark 断言用）。 */
  blockedHistoricalMediaBytes = 0;

  constructor(projectDir: string) {
    this.root = path.join(projectDir, STORAGE_DIR_NAME);
    this.blobStore = new BlobStore(this.root);
    fs.mkdirSync(this.root, { recursive: true });
    this.blobStore.ensureLayout();
    this.db = new Database(path.join(this.root, "database.sqlite"));
  }

  databasePath(): string {
    return path.join(this.root, "database.sqlite");
  }

  /** 核心 ingest：hash → blob → metadata → id */
  ingest(input: IngestInput): IngestResult {
    const hash = sha256Hex(input.data);
    const byteSize = input.data.byteLength;

    // 2. save blob（去重：同 hash 直接复用）
    const written = this.blobStore.write(input.data, hash, input.mimeType);
    this.db.upsertBlob(hash, written.path, byteSize, Date.now());

    // 3. create metadata（同 hash 已有 artifact 则复用 id）
    const existingId = this.db.findArtifactByHash(hash);
    if (existingId) {
      return { artifactId: existingId, blobHash: hash, byteSize, deduplicated: written.deduplicated, existing: true };
    }

    const artifactId = makeArtifactId(hash);
    this.db.insertArtifact({
      id: artifactId,
      blobHash: hash,
      mimeType: input.mimeType,
      byteSize,
      summary: input.summary ?? null,
      source: input.source,
      status: "active", // CREATED → ACTIVE：当前轮允许发送
      createdAt: Date.now(),
    });
    return { artifactId, blobHash: hash, byteSize, deduplicated: written.deduplicated, existing: false };
  }

  get(id: string): Artifact | undefined {
    const row = this.db.getArtifact(id);
    if (!row || !isStatus(row.status)) return undefined;
    return {
      id: row.id,
      blobHash: row.blobHash,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      summary: row.summary,
      source: row.source,
      status: row.status,
      createdAt: row.createdAt,
    };
  }

  findByHash(blobHash: string): Artifact | undefined {
    const id = this.db.findArtifactByHash(blobHash);
    return id ? this.get(id) : undefined;
  }

  list(includeArchived = false): Artifact[] {
    return this.db.listArtifacts(includeArchived).map((row) => ({
      id: row.id,
      blobHash: row.blobHash,
      mimeType: row.mimeType,
      byteSize: row.byteSize,
      summary: row.summary,
      source: row.source,
      status: (isStatus(row.status) ? row.status : "active") as ArtifactStatus,
      createdAt: row.createdAt,
    }));
  }

  /** 读取 blob 内容（artifact_get 恢复图片用）。 */
  readBlob(artifact: Artifact): Buffer {
    return this.blobStore.read(artifact.blobHash, artifact.mimeType);
  }

  /** blob 在磁盘上的绝对路径（临时恢复用）。 */
  blobAbsolutePath(artifact: Artifact): string {
    return this.blobStore.blobPath(artifact.blobHash, artifact.mimeType);
  }

  /** 生命周期迁移（带状态机校验）。 */
  transition(id: string, to: ArtifactStatus): Artifact {
    const artifact = this.get(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    const next = assertTransition(artifact.status, to);
    this.db.updateArtifactStatus(id, next);
    return { ...artifact, status: next };
  }

  /**
   * 标记为 consumed（幂等）。consumed/archived 状态不再重复迁移。
   */
  markConsumed(id: string): void {
    const artifact = this.get(id);
    if (!artifact) return;
    if (artifact.status === "active" || artifact.status === "created") {
      this.db.updateArtifactStatus(id, "consumed");
    }
  }

  stats(): ArtifactStats {
    return {
      artifactCount: this.db.artifactCount(),
      blobCount: this.db.blobCount(),
      storageBytes: this.blobStore.totalBytes(),
      historicalMediaBytes: this.blockedHistoricalMediaBytes,
    };
  }

  // ---- session state ----

  recordSession(sessionId: string, activeArtifactIds: string[]): void {
    this.db.upsertSession(sessionId, activeArtifactIds, Date.now());
  }

  getSessionArtifacts(sessionId: string): string[] {
    return this.db.getSession(sessionId)?.activeArtifacts ?? [];
  }

  close(): void {
    this.db.close();
  }
}
