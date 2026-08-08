/**
 * E2 — 多图负载 + Req 1（真实 pi 运行时）。
 *
 * MVP 完成标准 Requirement 1：
 *   上传多张图片后发送文本 → 后续 provider 请求 historical media bytes = 0。
 *
 * 同时记录 Payload Growth：每轮请求体积应保持平坦。
 */

import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createE2EHarness } from "./harness.js";
import { fakeImageBytes } from "../helpers.js";

describe("E2: 多图负载（真实 pi 运行时）", () => {
  it("Req 1：20 张图 + 后续文本轮 → 历史媒体字节 = 0", async () => {
    const harness = await createE2EHarness({ withPlugin: true });
    try {
      const imageCount = 20;
      const responses = [fauxAssistantMessage("全部收到")];
      for (let i = 0; i < 4; i++) responses.push(fauxAssistantMessage(`文本回复 ${i}`));
      harness.setResponses(responses);

      // turn 1：一次性上传 20 张图
      const images = Array.from({ length: imageCount }, (_, i) => ({
        type: "image" as const,
        data: fakeImageBytes(2000 + i, 24 * 1024).toString("base64"),
        mimeType: "image/png",
      }));
      await harness.session.prompt("这些是全部页面截图", { images });

      // turn 2-5：纯文本
      await harness.session.prompt("优化首页");
      await harness.session.prompt("调整导航");
      await harness.session.prompt("统一配色");
      await harness.session.prompt("最后检查");

      expect(harness.captured.length).toBeGreaterThanOrEqual(5);

      // 当前轮允许一次
      expect(harness.captured[0].mediaBytes).toBeGreaterThan(0);
      // 后续所有请求：0 历史媒体字节
      for (const req of harness.captured.slice(1)) {
        expect(req.mediaBytes).toBe(0);
      }

      // Payload Growth 平坦：最后一轮请求体积与第二轮相当（不随历史增长）
      const sizes = harness.captured.map((r) => r.totalBytes);
      const last = sizes[sizes.length - 1];
      const second = sizes[1];
      expect(last).toBeLessThan(second * 2);
      // 20 张图的 base64 体积远大于引用文本，第二轮起必须显著小于第一轮
      expect(second).toBeLessThan(sizes[0] / 2);
    } finally {
      await harness.cleanup();
    }
  });

  it("Req 1（字面标准）：100 张图片后 continue → historical_media_bytes = 0", async () => {
    const harness = await createE2EHarness({ withPlugin: true });
    try {
      harness.setResponses([
        fauxAssistantMessage("全部收到"),
        fauxAssistantMessage("继续中"),
      ]);

      // turn 1：一次性上传 100 张图（小尺寸控制运行时间）
      const images = Array.from({ length: 100 }, (_, i) => ({
        type: "image" as const,
        data: fakeImageBytes(3000 + i, 8 * 1024).toString("base64"),
        mimeType: "image/png",
      }));
      await harness.session.prompt("这些是全部页面截图", { images });

      // “continue”
      await harness.session.prompt("continue");

      expect(harness.captured.length).toBeGreaterThanOrEqual(2);

      // 当前轮允许一次：第一轮请求携带全部 100 张
      expect(harness.captured[0].mediaBytes).toBeGreaterThan(0);

      // Req 1 核心断言：continue 后的请求 historical media bytes = 0
      for (const req of harness.captured.slice(1)) {
        expect(req.mediaBytes).toBe(0);
      }

      // 100 个引用全部进入上下文消息（替换而非丢弃；
      // 只统计 messages，排除 tools 描述中的同名字样）
      const lastCtx = harness.captured[harness.captured.length - 1].context as {
        messages?: unknown[];
      };
      const turn2Json = JSON.stringify(lastCtx.messages ?? []);
      const refCount = turn2Json.split("[Artifact Reference]").length - 1;
      expect(refCount).toBe(100);
    } finally {
      await harness.cleanup();
    }
  });
});
