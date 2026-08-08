/**
 * RAR — Media Replay Amplification Ratio（媒体重放放大比）。
 *
 *   RAR = 累计发送媒体字节 / 用户实际输入唯一媒体字节
 *
 * 无插件：每轮重放全部历史图片 → RAR 随轮数线性增长（O(n) 缺陷）
 * 有插件：当前轮允许一次，之后恒为引用 → RAR ≈ 1
 *
 * 这是项目价值的核心量化指标：把媒体重放复杂度从 O(n) 降到 O(1)。
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { ArtifactStore } from "../../src/core/store.js";
import { transformContext, type AgentMessageLike } from "../../src/extension/context.js";
import {
  createTempStore, fakeImageBytes, makeImage, makeText,
  countMediaBytesInContext, replayAmplificationRatio,
} from "../helpers.js";

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

describe("RAR: 媒体重放放大比", () => {
  it("无插件：10 张图 × 10 轮 → RAR 约等于轮数（O(n) 重放）", () => {
    const imageCount = 10;
    const turns = 10;
    const images = Array.from({ length: imageCount }, (_, i) => fakeImageBytes(i));
    const uniqueInputBytes = images.reduce((sum, b) => sum + b.byteLength, 0);

    // 第一轮上传全部 10 张图
    const messages: AgentMessageLike[] = [
      { role: "user", content: images.map((b) => makeImage(b.toString("base64"))), timestamp: 0 },
      assistantMsg("ok", 1),
    ];

    // 无插件：每轮请求携带完整上下文 → 累计发送 = 每轮媒体字节之和
    let cumulativeSentBytes = countMediaBytesInContext(messages); // turn 1
    for (let turn = 2; turn <= turns; turn++) {
      messages.push({ role: "user", content: `文本指令 ${turn}`, timestamp: turn * 10 });
      messages.push(assistantMsg(`回复 ${turn}`, turn * 10 + 1));
      cumulativeSentBytes += countMediaBytesInContext(messages);
    }

    const rar = replayAmplificationRatio(cumulativeSentBytes, uniqueInputBytes);
    // 每轮都重放全部 10 张图 → RAR ≈ turns
    expect(rar).toBeGreaterThanOrEqual(turns - 1);
  });

  it("有插件：同样负载 → RAR ≈ 1（当前轮一次，之后 0）", () => {
    const imageCount = 10;
    const turns = 10;
    const images = Array.from({ length: imageCount }, (_, i) => fakeImageBytes(100 + i));
    const uniqueInputBytes = images.reduce((sum, b) => sum + b.byteLength, 0);

    const messages: AgentMessageLike[] = [
      { role: "user", content: images.map((b) => makeImage(b.toString("base64"))), timestamp: 0 },
      assistantMsg("ok", 1),
    ];

    // 有插件：每轮请求前 transformContext
    let cumulativeSentBytes = countMediaBytesInContext(transformContext(messages, store).messages);
    for (let turn = 2; turn <= turns; turn++) {
      messages.push({ role: "user", content: `文本指令 ${turn}`, timestamp: turn * 10 });
      messages.push(assistantMsg(`回复 ${turn}`, turn * 10 + 1));
      cumulativeSentBytes += countMediaBytesInContext(transformContext(messages, store).messages);
    }

    const rar = replayAmplificationRatio(cumulativeSentBytes, uniqueInputBytes);
    // 只有第一轮发送真实媒体 → RAR 精确等于 1
    expect(rar).toBe(1);
  });

  it("对比倍数：无插件 / 有插件 ≥ 轮数量级", () => {
    const images = Array.from({ length: 5 }, (_, i) => fakeImageBytes(200 + i));
    const uniqueInputBytes = images.reduce((sum, b) => sum + b.byteLength, 0);
    const turns = 8;

    const messages: AgentMessageLike[] = [
      { role: "user", content: images.map((b) => makeImage(b.toString("base64"))), timestamp: 0 },
      assistantMsg("ok", 1),
    ];

    let without = countMediaBytesInContext(messages);
    let withPlugin = countMediaBytesInContext(transformContext(messages, store).messages);
    for (let turn = 2; turn <= turns; turn++) {
      messages.push({ role: "user", content: `t${turn}`, timestamp: turn * 10 });
      messages.push(assistantMsg(`r${turn}`, turn * 10 + 1));
      without += countMediaBytesInContext(messages);
      withPlugin += countMediaBytesInContext(transformContext(messages, store).messages);
    }

    const rarWithout = replayAmplificationRatio(without, uniqueInputBytes);
    const rarWith = replayAmplificationRatio(withPlugin, uniqueInputBytes);
    expect(rarWithout / rarWith).toBeGreaterThanOrEqual(turns - 1);
  });
});
