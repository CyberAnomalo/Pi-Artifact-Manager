/**
 * Context Rewrite 单元测试 — 历史图片 → Artifact Reference。
 *
 * 当前轮判定规则（确定性）：
 *   最后一个 user message 起的消息 = 当前轮（含其后 toolResult/assistant），
 *   图片 allowed once；更早消息中的图片 = 历史媒体，一律替换。
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { ArtifactStore } from "../../src/core/store.js";
import { transformContext, base64ByteSize, type AgentMessageLike } from "../../src/extension/context.js";
import { createTempStore, fakeImageBytes, makeImage, makeText, countMediaBytesInContext } from "../helpers.js";

let fixture: ReturnType<typeof createTempStore>;
let store: ArtifactStore;

beforeEach(() => {
  fixture = createTempStore();
  store = fixture.store;
});

afterEach(() => fixture.cleanup());

function assistantMsg(text: string, ts: number): AgentMessageLike {
  return {
    role: "assistant", content: [makeText(text)], timestamp: ts,
    api: "test", provider: "test", model: "test", usage: {}, stopReason: "stop",
  } as unknown as AgentMessageLike;
}

describe("当前轮判定", () => {
  it("最后一个 user message 中的图片保留（allowed once）", () => {
    const b64 = fakeImageBytes(1).toString("base64");
    const messages: AgentMessageLike[] = [
      { role: "user", content: [makeText("看这个"), makeImage(b64)], timestamp: 1 },
    ];
    const result = transformContext(messages, store);
    expect(countMediaBytesInContext(result.messages)).toBe(base64ByteSize(b64));
    expect(result.replacedCount).toBe(0);
  });

  it("当前轮内的 toolResult 图片也属于当前轮", () => {
    const b64 = fakeImageBytes(2).toString("base64");
    const messages: AgentMessageLike[] = [
      { role: "user", content: "截个图", timestamp: 1 },
      assistantMsg("好的", 2),
      { role: "toolResult", content: [makeImage(b64)], timestamp: 3 } as unknown as AgentMessageLike,
    ];
    const result = transformContext(messages, store);
    expect(countMediaBytesInContext(result.messages)).toBe(base64ByteSize(b64));
    expect(result.replacedCount).toBe(0);
  });

  it("新文本轮到达后，历史图片全部替换", () => {
    const b64 = fakeImageBytes(3).toString("base64");
    const messages: AgentMessageLike[] = [
      { role: "user", content: [makeImage(b64)], timestamp: 1 },
      assistantMsg("收到", 2),
      { role: "user", content: "继续优化按钮", timestamp: 3 },
    ];
    const result = transformContext(messages, store);
    expect(countMediaBytesInContext(result.messages)).toBe(0);
    expect(result.replacedCount).toBe(1);
  });
});

describe("替换语义", () => {
  it("替换文本包含 artifact id 与恢复指引", () => {
    const b64 = fakeImageBytes(4).toString("base64");
    const messages: AgentMessageLike[] = [
      { role: "user", content: [makeImage(b64)], timestamp: 1 },
      assistantMsg("ok", 2),
      { role: "user", content: "next", timestamp: 3 },
    ];
    const result = transformContext(messages, store);
    const textBlocks = (result.messages[0].content as { type: string; text?: string }[]).filter(
      (b) => b.type === "text",
    );
    const refText = textBlocks.map((b) => b.text).join("\n");
    expect(refText).toContain("[Artifact Reference]");
    expect(refText).toMatch(/id: artifact_[0-9a-f]{7}/);
    expect(refText).toContain("artifact_get");
  });

  it("lazy ingest：未入库的历史图片替换时现场入库", () => {
    const b64 = fakeImageBytes(5).toString("base64");
    const messages: AgentMessageLike[] = [
      { role: "user", content: [makeImage(b64)], timestamp: 1 },
      assistantMsg("ok", 2),
      { role: "user", content: "next", timestamp: 3 },
    ];
    expect(store.list().length).toBe(0);
    const result = transformContext(messages, store);
    expect(store.list().length).toBe(1);
    expect(result.artifactIds.length).toBe(1);
    // 替换即消费
    expect(store.get(result.artifactIds[0])?.status).toBe("consumed");
  });

  it("已入库图片按 hash 复用 artifact（不重复建记录）", () => {
    const bytes = fakeImageBytes(6);
    const ingested = store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    const messages: AgentMessageLike[] = [
      { role: "user", content: [makeImage(bytes.toString("base64"))], timestamp: 1 },
      assistantMsg("ok", 2),
      { role: "user", content: "next", timestamp: 3 },
    ];
    const result = transformContext(messages, store);
    expect(result.artifactIds).toEqual([ingested.artifactId]);
    expect(store.list().length).toBe(1);
  });

  it("toolResult 中的历史图片也被替换（source 标记 tool-result）", () => {
    const b64 = fakeImageBytes(7).toString("base64");
    const messages: AgentMessageLike[] = [
      { role: "user", content: "截图", timestamp: 1 },
      { role: "toolResult", content: [makeImage(b64)], timestamp: 2 } as unknown as AgentMessageLike,
      assistantMsg("done", 3),
      { role: "user", content: "next", timestamp: 4 },
    ];
    const result = transformContext(messages, store);
    expect(result.replacedCount).toBe(1);
    expect(store.list()[0].source).toBe("tool-result");
  });
});
