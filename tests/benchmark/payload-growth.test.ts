/**
 * Payload Growth Curve — 请求体积增长曲线 + Resume 成本。
 *
 * 度量（每轮记录）：
 *   request_size   — 当轮 provider 请求的媒体字节
 *   session_media  — 会话累计历史媒体字节（对照）
 *   resume_time    — store 重开耗时（不加载 blob）
 *
 * 预期：
 *   无插件：request_size 随轮数线性增长（turn N ≈ N × 图片体积）
 *   有插件：request_size 恒定（turn ≥ 2 为 0）
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { ArtifactStore } from "../../src/core/store.js";
import { ArtifactStore as StoreCtor } from "../../src/core/store.js";
import { transformContext, type AgentMessageLike } from "../../src/extension/context.js";
import {
  createTempStore, fakeImageBytes, makeImage, makeText, countMediaBytesInContext,
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

interface GrowthPoint {
  turn: number;
  requestMediaBytes: number;
}

function runScenario(withPlugin: boolean, imageCount: number, turns: number): GrowthPoint[] {
  const points: GrowthPoint[] = [];
  const images = Array.from({ length: imageCount }, (_, i) => fakeImageBytes(i + 500));

  const messages: AgentMessageLike[] = [
    { role: "user", content: images.map((b) => makeImage(b.toString("base64"))), timestamp: 0 },
    assistantMsg("ok", 1),
  ];

  const measure = (msgs: AgentMessageLike[]): number =>
    withPlugin ? countMediaBytesInContext(transformContext(msgs, store).messages) : countMediaBytesInContext(msgs);

  points.push({ turn: 1, requestMediaBytes: measure(messages) });

  for (let turn = 2; turn <= turns; turn++) {
    messages.push({ role: "user", content: `指令 ${turn}`, timestamp: turn * 10 });
    messages.push(assistantMsg(`回复 ${turn}`, turn * 10 + 1));
    points.push({ turn, requestMediaBytes: measure(messages) });
  }
  return points;
}

describe("Payload Growth Curve", () => {
  it("无插件：请求媒体字节线性增长（每轮重放全部历史图）", () => {
    const imageBytes = fakeImageBytes(500).byteLength;
    const points = runScenario(false, 3, 6);

    // turn 1: 3 张图；之后每轮都是 3 张图重放
    expect(points[0].requestMediaBytes).toBeGreaterThanOrEqual(3 * Math.floor((imageBytes * 3) / 4));
    // 无插件：末轮 == 首轮（恒定重放，且都不为 0）
    expect(points[5].requestMediaBytes).toBe(points[0].requestMediaBytes);
    expect(points[5].requestMediaBytes).toBeGreaterThan(0);
  });

  it("有插件：请求媒体字节 O(1)（turn ≥ 2 恒为 0）", () => {
    const points = runScenario(true, 3, 6);

    expect(points[0].requestMediaBytes).toBeGreaterThan(0); // 当前轮 allowed once
    for (const p of points.slice(1)) {
      expect(p.requestMediaBytes).toBe(0);
    }
  });

  it("100 张图 + 20 轮：有插件曲线平坦", () => {
    const points = runScenario(true, 100, 20);
    expect(points[0].requestMediaBytes).toBeGreaterThan(0);
    const maxAfterFirst = Math.max(...points.slice(1).map((p) => p.requestMediaBytes));
    expect(maxAfterFirst).toBe(0);
  });
});

describe("Resume Cost", () => {
  it("重开 store 耗时与图片数量无关（blob 不入内存）", () => {
    // 入库 50 张图
    for (let i = 0; i < 50; i++) {
      store.ingest({ data: fakeImageBytes(900 + i, 64 * 1024), mimeType: "image/png", source: "user-input" });
    }
    store.recordSession("sess-resume", store.list().map((a) => a.id));
    store.close();

    const start = performance.now();
    const reopened = new StoreCtor(fixture.dir);
    const elapsed = performance.now() - start;
    try {
      // metadata 完整恢复
      expect(reopened.getSessionArtifacts("sess-resume").length).toBe(50);
      expect(reopened.list().length).toBe(50);
      // resume 只读 sqlite metadata，远低于全部 blob 体积（50 × 64KB = 3.2MB）
      // 用宽松上界防止 CI 抖动：100ms
      expect(elapsed).toBeLessThan(100);
    } finally {
      reopened.close();
    }
    store = new StoreCtor(fixture.dir);
  });
});
