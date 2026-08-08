/**
 * E1 — 泄漏增长曲线 A/B（真实 pi 运行时）。
 *
 * 实验设计 Step 2：先写失败基线 —— 无插件时历史图片必然重放，
 * 证明「多模态上下文媒体重放缺陷」真实存在；
 * 再证明有插件时媒体重放被消除。
 *
 * 度量来自 provider 出口捕获（faux provider 收到的真实 Context）。
 */

import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createE2EHarness } from "./harness.js";
import { fakeImageBytes } from "../helpers.js";

describe("E1: 泄漏增长曲线（真实 pi 运行时 A/B）", () => {
  it("基线（无插件）：历史图片在每次 provider 请求中重放 —— 缺陷存在", async () => {
    const harness = await createE2EHarness({ withPlugin: false });
    try {
      harness.setResponses([
        fauxAssistantMessage("收到图片"),
        fauxAssistantMessage("回复2"),
        fauxAssistantMessage("回复3"),
        fauxAssistantMessage("回复4"),
      ]);

      const image = {
        type: "image" as const,
        data: fakeImageBytes(301, 48 * 1024).toString("base64"),
        mimeType: "image/png",
      };

      // turn 1: 带图
      await harness.session.prompt("看这张图", { images: [image] });
      // turn 2-4: 纯文本
      await harness.session.prompt("继续优化按钮");
      await harness.session.prompt("再调整间距");
      await harness.session.prompt("最后确认");

      // 至少 4 次 provider 请求被捕获
      expect(harness.captured.length).toBeGreaterThanOrEqual(4);

      // 失败基线断言：无插件时每次请求都携带历史图片（媒体重放缺陷）
      for (const req of harness.captured) {
        expect(req.mediaBytes).toBeGreaterThan(0);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("有插件：当前轮允许一次，之后恒为 0 —— O(1) 媒体重放", async () => {
    const harness = await createE2EHarness({ withPlugin: true });
    try {
      harness.setResponses([
        fauxAssistantMessage("收到图片"),
        fauxAssistantMessage("回复2"),
        fauxAssistantMessage("回复3"),
        fauxAssistantMessage("回复4"),
      ]);

      const imageBytes = fakeImageBytes(302, 48 * 1024);
      const image = {
        type: "image" as const,
        data: imageBytes.toString("base64"),
        mimeType: "image/png",
      };

      await harness.session.prompt("看这张图", { images: [image] });
      await harness.session.prompt("继续优化按钮");
      await harness.session.prompt("再调整间距");
      await harness.session.prompt("最后确认");

      expect(harness.captured.length).toBeGreaterThanOrEqual(4);

      // turn 1 请求：图片 allowed once
      expect(harness.captured[0].mediaBytes).toBeGreaterThan(0);
      // turn ≥ 2 请求：0 媒体字节（历史图片已替换为 artifact 引用）
      for (const req of harness.captured.slice(1)) {
        expect(req.mediaBytes).toBe(0);
      }

      // 引用文本确实进入了上下文（替换而非丢弃）
      const turn2Json = JSON.stringify(harness.captured[1].context);
      expect(turn2Json).toContain("[Artifact Reference]");
      expect(turn2Json).toMatch(/artifact_[0-9a-f]{7}/);
    } finally {
      await harness.cleanup();
    }
  });

  it("请求体积对比：有插件时后续请求显著更小", async () => {
    const harness = await createE2EHarness({ withPlugin: true });
    try {
      harness.setResponses([
        fauxAssistantMessage("收到图片"),
        fauxAssistantMessage("回复2"),
      ]);

      const image = {
        type: "image" as const,
        data: fakeImageBytes(303, 96 * 1024).toString("base64"),
        mimeType: "image/png",
      };

      await harness.session.prompt("看这张图", { images: [image] });
      await harness.session.prompt("继续");

      const first = harness.captured[0].totalBytes;
      const second = harness.captured[1].totalBytes;
      // 第二轮请求体积必须明显小于第一轮（图片 base64 约 128KB JSON 体积）
      expect(second).toBeLessThan(first - 50 * 1024);
    } finally {
      await harness.cleanup();
    }
  });
});
