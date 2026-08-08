/**
 * Payload Guard 单元测试 — Fail-closed 安全边界验证。
 *
 * 核心断言：guard 是最后防线，未授权媒体必须被拦截。
 *   - audit(): 发现泄漏抛 HistoricalMediaLeakError（严格检测）
 *   - sanitize(): 剥离媒体（生产路径，媒体永远不进入 payload）
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import type { ArtifactStore } from "../../src/core/store.js";
import { PayloadGuard } from "../../src/extension/guard.js";
import { HistoricalMediaLeakError, ZERO_MEDIA_POLICY, type MediaPolicy } from "../../src/extension/policy.js";
import { createTempStore, fakeImageBytes } from "../helpers.js";

let fixture: ReturnType<typeof createTempStore>;
let store: ArtifactStore;

beforeEach(() => {
  fixture = createTempStore();
  store = fixture.store;
});

afterEach(() => fixture.cleanup());

describe("Fail-closed: audit 抛 HistoricalMediaLeakError", () => {
  it("历史媒体存在 → audit throws", () => {
    const guard = new PayloadGuard(store, () => new Set());
    const b64 = fakeImageBytes(1).toString("base64");
    const payload = { messages: [{ role: "user", content: [{ type: "image", data: b64, mimeType: "image/png" }] }] };

    expect(() => guard.audit(payload)).toThrow(HistoricalMediaLeakError);
    expect(() => guard.audit(payload)).toThrow(/Historical media leak detected/);
  });

  it("错误对象携带泄漏详情（count/bytes/artifact refs）", () => {
    // 先 ingest 使图片成为已知 artifact
    const bytes = fakeImageBytes(2);
    const ingested = store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    const guard = new PayloadGuard(store, () => new Set());

    const payload = { content: [{ type: "image", data: bytes.toString("base64") }] };
    try {
      guard.audit(payload);
      throw new Error("audit should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HistoricalMediaLeakError);
      const leak = err as HistoricalMediaLeakError;
      expect(leak.leakCount).toBe(1);
      expect(leak.leakBytes).toBeGreaterThan(0);
      expect(leak.artifactRefs).toEqual([ingested.artifactId]);
    }
  });

  it("干净 payload → audit 不抛", () => {
    const guard = new PayloadGuard(store, () => new Set());
    expect(() => guard.audit({ messages: [{ role: "user", content: "纯文本" }] })).not.toThrow();
    expect(() => guard.audit(null)).not.toThrow();
  });

  it("ZERO_MEDIA_POLICY：即使授权集合非空也拒绝一切媒体", () => {
    const bytes = fakeImageBytes(3);
    const ingested = store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    const guard = new PayloadGuard(store, () => new Set([ingested.blobHash]));

    const payload = { content: [{ type: "image", data: bytes.toString("base64") }] };
    expect(() => guard.audit(payload, ZERO_MEDIA_POLICY)).toThrow(HistoricalMediaLeakError);
  });
});

describe("sanitize 生产路径：媒体永远不进入 payload", () => {
  it("文本轮允许 0 image bytes（未知媒体剥离）", () => {
    const guard = new PayloadGuard(store, () => new Set());
    const b64 = fakeImageBytes(5).toString("base64");
    const payload = {
      messages: [
        { role: "user", content: [{ type: "image", data: b64, mimeType: "image/png" }] },
        { role: "user", content: "继续优化按钮" },
      ],
    };

    const result = guard.sanitize(payload);
    expect(result.blocked).toBe(1);
    const json = JSON.stringify(result.payload);
    expect(json.includes(b64)).toBe(false);
    expect(json).toContain("Historical media blocked");
  });

  it("当前轮 ingest 的图片放行", () => {
    const bytes = fakeImageBytes(6);
    const ingested = store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    const guard = new PayloadGuard(store, () => new Set([ingested.blobHash]));

    const payload = {
      messages: [{ role: "user", content: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] }],
    };
    const result = guard.sanitize(payload);
    expect(result.blocked).toBe(0);
    expect(JSON.stringify(result.payload)).toContain(bytes.toString("base64").slice(0, 64));
  });

  it("provider 专属形态全覆盖（input_image / image_url / data URI / anthropic source）", () => {
    const guard = new PayloadGuard(store, () => new Set());
    const b64 = fakeImageBytes(8).toString("base64");
    const payload = {
      messages: [
        { role: "user", content: [{ type: "input_image", data: b64 }] },
        { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } }] },
        { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] },
        { role: "user", attachments: { screenshot: `data:image/jpeg;base64,${b64}` } },
      ],
    };

    const result = guard.sanitize(payload);
    expect(result.blocked).toBe(4);
    expect(JSON.stringify(result.payload).includes(b64)).toBe(false);
  });

  it("非媒体内容不受影响（文本/base64 文本文件不误伤）", () => {
    const guard = new PayloadGuard(store, () => new Set());
    const shortText = "hello";
    const payload = {
      messages: [
        { role: "user", content: [{ type: "text", text: shortText }] },
        { role: "tool", output: { file: { name: "a.txt", content: Buffer.from("file content").toString("base64") } } },
      ],
    };
    const result = guard.sanitize(payload);
    expect(result.blocked).toBe(0);
    expect(JSON.stringify(result.payload)).toContain(shortText);
  });

  it("blocked 字节累加进 store 统计", () => {
    const guard = new PayloadGuard(store, () => new Set());
    const b64 = fakeImageBytes(9).toString("base64");
    const before = store.blockedHistoricalMediaBytes;
    guard.sanitize({ content: [{ type: "image", data: b64 }] });
    expect(store.blockedHistoricalMediaBytes).toBeGreaterThan(before);
  });

  it("含不可克隆节点的 payload（真实 Context 带 tools/execute 函数）不抛错且照常剥离", () => {
    // 回归：整包 structuredClone 对含函数引用的真实 provider Context 抛
    // DataCloneError，钩子抛错被 runner 吞掉 → guard 静默 fail-open（E8 实测）。
    const guard = new PayloadGuard(store, () => new Set());
    const b64 = fakeImageBytes(10).toString("base64");
    const execute = async () => ({ output: "ok" });
    const payload = {
      messages: [{ role: "user", content: [{ type: "image", data: b64, mimeType: "image/png" }] }],
      tools: [{ name: "read", description: "读文件", execute }],
    };

    const result = guard.sanitize(payload);
    expect(result.blocked).toBe(1);
    const out = result.payload as { messages: unknown[]; tools: { execute: unknown }[] };
    expect(JSON.stringify(out.messages).includes(b64)).toBe(false);
    // tools 不可克隆但必须原样保留（引用透传），否则破坏 provider 请求
    expect(out.tools[0].execute).toBe(execute);
  });
});

describe("MediaPolicy 预算强制（maxImages / maxMediaBytes）", () => {
  function multiImagePayload(hashes: string[]): unknown {
    return {
      messages: hashes.map((_, i) => ({
        role: "user",
        content: [{ type: "image", data: fakeImageBytes(60 + i).toString("base64"), mimeType: "image/png" }],
      })),
    };
  }

  it("maxImages=1：授权集合内的第 2 张图也被剥离（超预算 = 泄漏）", () => {
    const b1 = fakeImageBytes(60);
    const b2 = fakeImageBytes(61);
    const i1 = store.ingest({ data: b1, mimeType: "image/png", source: "user-input" });
    const i2 = store.ingest({ data: b2, mimeType: "image/png", source: "user-input" });
    const guard = new PayloadGuard(store, () => new Set([i1.blobHash, i2.blobHash]));

    const policy: MediaPolicy = {
      allowCurrentTurnMedia: true,
      allowArtifactHydration: true,
      maxImages: 1,
      maxMediaBytes: Number.POSITIVE_INFINITY,
    };

    const result = guard.sanitize(multiImagePayload(["a", "b"]), policy);
    expect(result.blocked).toBe(1); // 第二张超预算被剥离
    expect(JSON.stringify(result.payload).includes(b2.toString("base64"))).toBe(false);
    expect(JSON.stringify(result.payload).includes(b1.toString("base64"))).toBe(true);
  });

  it("maxMediaBytes 不足：即使授权也拒绝（字节预算）", () => {
    const bytes = fakeImageBytes(62, 30 * 1024);
    const ingested = store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    const guard = new PayloadGuard(store, () => new Set([ingested.blobHash]));

    const policy: MediaPolicy = {
      allowCurrentTurnMedia: true,
      allowArtifactHydration: true,
      maxImages: Number.POSITIVE_INFINITY,
      maxMediaBytes: 1024, // 远小于图片实际体积
    };

    const result = guard.sanitize({ content: [{ type: "image", data: bytes.toString("base64") }] }, policy);
    expect(result.blocked).toBe(1);
    // audit 同样抛错（严格模式）
    expect(() =>
      guard.audit({ content: [{ type: "image", data: bytes.toString("base64") }] }, policy),
    ).toThrow(HistoricalMediaLeakError);
  });

  it("预算充足：授权媒体正常放行（不误伤）", () => {
    const bytes = fakeImageBytes(63);
    const ingested = store.ingest({ data: bytes, mimeType: "image/png", source: "user-input" });
    const guard = new PayloadGuard(store, () => new Set([ingested.blobHash]));

    const policy: MediaPolicy = {
      allowCurrentTurnMedia: true,
      allowArtifactHydration: true,
      maxImages: 4,
      maxMediaBytes: 10 * 1024 * 1024,
    };

    const result = guard.sanitize({ content: [{ type: "image", data: bytes.toString("base64") }] }, policy);
    expect(result.blocked).toBe(0);
    expect(() =>
      guard.audit({ content: [{ type: "image", data: bytes.toString("base64") }] }, policy),
    ).not.toThrow();
  });
});
