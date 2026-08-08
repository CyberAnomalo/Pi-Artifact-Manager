/**
 * Agent Tools 单元测试 — artifact_list / artifact_get / artifact_stats。
 *
 * 直接驱动工具工厂返回的 execute()，验证：
 *   - list：空库 / 有数据 / include_archived
 *   - get：非法 id / 不存在 / 正常恢复（图片块 + 状态迁移 + onReload 回调）
 *   - stats：计数与泄漏统计
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { ArtifactStore } from "../../src/core/store.js";
import { createListTool } from "../../src/tools/list.js";
import { createGetTool } from "../../src/tools/get.js";
import { createStatsTool } from "../../src/tools/stats.js";
import { createTempStore, fakeImageBytes } from "../helpers.js";

let fixture: ReturnType<typeof createTempStore>;
let store: ArtifactStore;

beforeEach(() => {
  fixture = createTempStore();
  store = fixture.store;
});

afterEach(() => fixture.cleanup());

function textOf(result: { content: { type: string; text?: string; data?: string }[] }): string {
  return result.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

describe("artifact_list", () => {
  it("空库返回提示", async () => {
    const tool = createListTool(store);
    const result = await tool.execute("t1", {});
    expect(textOf(result)).toContain("No artifacts");
  });

  it("列出 id / size / status，序号从 1 开始", async () => {
    store.ingest({ data: fakeImageBytes(1), mimeType: "image/png", source: "user-input" });
    store.ingest({ data: fakeImageBytes(2), mimeType: "image/png", source: "user-input" });
    const tool = createListTool(store);
    const result = await tool.execute("t1", {});
    const text = textOf(result);
    expect(text).toContain("Artifact #1");
    expect(text).toContain("Artifact #2");
    expect(text).toMatch(/artifact_[0-9a-f]{7}/);
    expect(text).toContain("status: active");
  });

  it("archived 默认隐藏，include_archived 显示", async () => {
    const ingested = store.ingest({ data: fakeImageBytes(3), mimeType: null, source: "user-input" });
    store.transition(ingested.artifactId, "archived");
    const tool = createListTool(store);
    expect(textOf(await tool.execute("t1", {}))).toContain("No artifacts");
    expect(textOf(await tool.execute("t2", { include_archived: true }))).toContain(ingested.artifactId);
  });
});

describe("artifact_get", () => {
  it("非法 id 拒绝", async () => {
    const tool = createGetTool(store, () => {});
    const result = await tool.execute("t1", { id: "../../etc/passwd" });
    expect(textOf(result)).toContain("Invalid artifact id");
    expect(result.details.ok).toBe(false);
  });

  it("不存在的 id 报错", async () => {
    const tool = createGetTool(store, () => {});
    const result = await tool.execute("t1", { id: "artifact_0000000" });
    expect(textOf(result)).toContain("not found");
  });

  it("正常恢复：图片块 + consumed→active + onReload 回调", async () => {
    const bytes = fakeImageBytes(9);
    const ingested = store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    store.markConsumed(ingested.artifactId);

    const reloaded: Array<[string, string]> = [];
    const tool = createGetTool(store, (hash, id) => reloaded.push([hash, id]));

    const result = await tool.execute("t1", { id: ingested.artifactId });

    // 返回图片块，字节级一致
    expect(result.content.length).toBe(1);
    const block = result.content[0] as { type: string; data: string; mimeType: string };
    expect(block.type).toBe("image");
    expect(block.data).toBe(bytes.toString("base64"));
    expect(block.mimeType).toBe("image/png");

    // 状态迁移 + guard 放行回调
    expect(store.get(ingested.artifactId)?.status).toBe("active");
    expect(reloaded).toEqual([[ingested.blobHash, ingested.artifactId]]);
  });
});

describe("artifact_stats", () => {
  it("统计数量 / 存储字节 / 泄漏计数", async () => {
    store.ingest({ data: fakeImageBytes(21, 10 * 1024), mimeType: "image/png", source: "user-input" });
    store.ingest({ data: fakeImageBytes(22, 10 * 1024), mimeType: "image/png", source: "user-input" });
    store.blockedHistoricalMediaBytes = 12345;

    const counters = { contextRemovedMediaBytes: 99999, guardBlockedMediaBytes: 12345 };
    const tool = createStatsTool(store, counters);
    const result = await tool.execute("t1", {});
    const text = textOf(result);

    expect(text).toContain("2"); // artifact count
    expect(text).toContain("2 deduplicated blobs");
    expect(text).toContain("12345"); // guard blocked
    expect(text).toContain("99999"); // context removed
    // 泄漏估算 = context removed - guard blocked
    expect(text).toContain("87654");
  });
});
