/**
 * BlobStore / ArtifactStore / Lifecycle 单元测试。
 *
 * 覆盖：sha256 去重、生命周期状态机、resume 元数据恢复。
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { ArtifactStore } from "../../src/core/store.js";
import { ArtifactStore as StoreCtor } from "../../src/core/store.js";
import { isValidArtifactId, makeArtifactId } from "../../src/core/artifact.js";
import { canTransition } from "../../src/core/lifecycle.js";
import { createTempStore, fakeImageBytes } from "../helpers.js";

let fixture: ReturnType<typeof createTempStore>;
let store: ArtifactStore;

beforeEach(() => {
  fixture = createTempStore();
  store = fixture.store;
});

afterEach(() => fixture.cleanup());

describe("Blob 去重", () => {
  it("同图 100 次上传 = 1 份 blob", () => {
    const bytes = fakeImageBytes(42);
    for (let i = 0; i < 100; i++) {
      store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    }
    const stats = store.stats();
    expect(stats.artifactCount).toBe(1);
    expect(stats.blobCount).toBe(1);
    expect(stats.storageBytes).toBe(bytes.byteLength);
  });

  it("artifact id 格式为 artifact_<7位hex>", () => {
    const ingested = store.ingest({ data: fakeImageBytes(1), mimeType: null, source: "user-input" });
    expect(isValidArtifactId(ingested.artifactId)).toBe(true);
    expect(ingested.artifactId).toMatch(/^artifact_[0-9a-f]{7}$/);
    expect(ingested.artifactId).toBe(makeArtifactId(ingested.blobHash));
  });
});

describe("Lifecycle 状态机", () => {
  it("CREATED→ACTIVE→CONSUMED→ARCHIVED 链", () => {
    const ingested = store.ingest({ data: fakeImageBytes(11), mimeType: null, source: "user-input" });
    expect(store.get(ingested.artifactId)?.status).toBe("active");

    store.transition(ingested.artifactId, "consumed");
    expect(store.get(ingested.artifactId)?.status).toBe("consumed");

    store.transition(ingested.artifactId, "archived");
    expect(store.get(ingested.artifactId)?.status).toBe("archived");

    // archived 是终态；不进入默认查询
    expect(() => store.transition(ingested.artifactId, "active")).toThrow();
    expect(store.list().length).toBe(0);
    expect(store.list(true).length).toBe(1);
  });

  it("consumed → active 允许（artifact_get 重载路径）", () => {
    const ingested = store.ingest({ data: fakeImageBytes(12), mimeType: null, source: "user-input" });
    store.markConsumed(ingested.artifactId);
    expect(canTransition("consumed", "active")).toBe(true);
    store.transition(ingested.artifactId, "active");
    expect(store.get(ingested.artifactId)?.status).toBe("active");
  });

  it("非法迁移拒绝（created→consumed）", () => {
    expect(canTransition("created", "consumed")).toBe(false);
  });
});

describe("Resume（元数据恢复，blob 不加载）", () => {
  it("重开 store 恢复 metadata；blob 按需读取", () => {
    const bytes = fakeImageBytes(7);
    const ingested = store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    store.recordSession("session-abc", [ingested.artifactId]);
    store.close();

    const reopened = new StoreCtor(fixture.dir);
    try {
      const artifact = reopened.get(ingested.artifactId);
      expect(artifact).toBeDefined();
      expect(reopened.getSessionArtifacts("session-abc")).toEqual([ingested.artifactId]);
      const restored = reopened.readBlob(artifact!);
      expect(restored.equals(bytes)).toBe(true);
    } finally {
      reopened.close();
    }
    // 重新打开供 afterEach cleanup
    store = new StoreCtor(fixture.dir);
  });
});
