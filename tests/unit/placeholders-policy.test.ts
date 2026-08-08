/**
 * Placeholders / Policy / Context 边界测试。
 *
 * 设计原则验证：
 *   - 所有未实现功能 fail fast（PLACEHOLDER 抛错，绝不静默）
 *   - MediaPolicy 常量形状正确
 *   - transformContext 边界输入安全
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  UnimplementedSemanticClassifier,
  UnimplementedRevisionManager,
  UnimplementedArtifactBranchService,
  UnimplementedArtifactComparator,
  CodexAdapter,
  OpenCodeAdapter,
  UnimplementedArtifactCoreDaemon,
} from "../../src/core/placeholders.js";
import { DEFAULT_MEDIA_POLICY, ZERO_MEDIA_POLICY } from "../../src/extension/policy.js";
import { transformContext, type AgentMessageLike } from "../../src/extension/context.js";
import { createTempStore, fakeImageBytes, makeImage } from "../helpers.js";

describe("PLACEHOLDER fail-fast（明确不实现的功能绝不静默）", () => {
  const fakeArtifact = {
    id: "artifact_0000000", blobHash: "0".repeat(64), mimeType: null, byteSize: 0,
    summary: null, source: "unknown", status: "active" as const, createdAt: 0,
  };

  it("SemanticClassifier 抛错（不依赖 LLM 分类）", async () => {
    await expect(new UnimplementedSemanticClassifier().classify(fakeArtifact)).rejects.toThrow(/PLACEHOLDER/);
  });

  it("RevisionManager 抛错", async () => {
    const rm = new UnimplementedRevisionManager();
    await expect(rm.createRevision("a", Buffer.alloc(1))).rejects.toThrow(/PLACEHOLDER/);
    await expect(rm.getRevisionHistory("a")).rejects.toThrow(/PLACEHOLDER/);
  });

  it("ArtifactBranchService 抛错", async () => {
    const bs = new UnimplementedArtifactBranchService();
    await expect(bs.createBranch("a", "b")).rejects.toThrow(/PLACEHOLDER/);
    await expect(bs.listBranches("a")).rejects.toThrow(/PLACEHOLDER/);
  });

  it("ArtifactComparator 抛错", async () => {
    await expect(new UnimplementedArtifactComparator().compare(fakeArtifact, fakeArtifact)).rejects.toThrow(
      /PLACEHOLDER/,
    );
  });

  it("CodexAdapter / OpenCodeAdapter 抛错（MVP 只支持 Pi）", () => {
    expect(() => new CodexAdapter().attach({})).toThrow(/PLACEHOLDER/);
    expect(() => new OpenCodeAdapter().attach({})).toThrow(/PLACEHOLDER/);
    expect(new CodexAdapter().name).toBe("codex");
    expect(new OpenCodeAdapter().name).toBe("opencode");
  });

  it("ArtifactCoreDaemon 抛错（MVP 进程内运行）", async () => {
    const daemon = new UnimplementedArtifactCoreDaemon();
    await expect(daemon.start()).rejects.toThrow(/PLACEHOLDER/);
    await expect(daemon.stop()).rejects.toThrow(/PLACEHOLDER/);
  });
});

describe("MediaPolicy 常量", () => {
  it("DEFAULT：当前轮与 hydration 允许，无硬上限", () => {
    expect(DEFAULT_MEDIA_POLICY.allowCurrentTurnMedia).toBe(true);
    expect(DEFAULT_MEDIA_POLICY.allowArtifactHydration).toBe(true);
    expect(DEFAULT_MEDIA_POLICY.maxMediaBytes).toBe(Number.POSITIVE_INFINITY);
    expect(DEFAULT_MEDIA_POLICY.maxImages).toBe(Number.POSITIVE_INFINITY);
  });

  it("ZERO_MEDIA_POLICY：0 容忍（测试/对抗用）", () => {
    expect(ZERO_MEDIA_POLICY.allowCurrentTurnMedia).toBe(false);
    expect(ZERO_MEDIA_POLICY.allowArtifactHydration).toBe(false);
    expect(ZERO_MEDIA_POLICY.maxMediaBytes).toBe(0);
    expect(ZERO_MEDIA_POLICY.maxImages).toBe(0);
  });
});

describe("transformContext 边界输入", () => {
  let fixture: ReturnType<typeof createTempStore>;

  beforeEach(() => {
    fixture = createTempStore();
  });
  afterEach(() => fixture.cleanup());

  it("无 user message：保守不替换", () => {
    const messages: AgentMessageLike[] = [
      { role: "system", content: [makeImage(fakeImageBytes(31).toString("base64"))], timestamp: 1 } as AgentMessageLike,
    ];
    const result = transformContext(messages, fixture.store);
    expect(result.replacedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("空消息数组安全返回", () => {
    const result = transformContext([], fixture.store);
    expect(result.replacedCount).toBe(0);
    expect(result.messages.length).toBe(0);
  });

  it("string content 的 user message 不崩溃", () => {
    const messages: AgentMessageLike[] = [
      { role: "user", content: "纯文本", timestamp: 1 },
    ];
    const result = transformContext(messages, fixture.store);
    expect(result.replacedCount).toBe(0);
  });

  it("非图片块（toolCall 等）原样保留", () => {
    const messages: AgentMessageLike[] = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} } as never],
        timestamp: 1,
      } as AgentMessageLike,
      { role: "user", content: "next", timestamp: 2 },
    ];
    const result = transformContext(messages, fixture.store);
    expect(result.replacedCount).toBe(0);
    const blocks = result.messages[0].content as { type: string }[];
    expect(blocks[0].type).toBe("toolCall");
  });

  it("原始消息不被原地修改（纯函数性）", () => {
    const b64 = fakeImageBytes(32).toString("base64");
    const messages: AgentMessageLike[] = [
      { role: "user", content: [makeImage(b64)], timestamp: 1 },
      { role: "user", content: "next", timestamp: 2 },
    ];
    const before = JSON.stringify(messages);
    transformContext(messages, fixture.store);
    expect(JSON.stringify(messages)).toBe(before);
  });
});
