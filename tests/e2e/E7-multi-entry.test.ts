/**
 * E7 — 多入口媒体泄漏测试（真实 pi 运行时）。
 *
 * 真实泄漏来源盘点（pi 数据模型层面的完整枚举）：
 *   1. 用户输入（@image / prompt images）→ E1 已覆盖，本文件有混合用例
 *   2. tool result（浏览器截图类工具返回图片）← 本测试
 *   3. session resume（会话文件携带历史图片）→ E3 覆盖
 *
 * 关于 "assistant 生成图片" 入口：pi-ai 的 AssistantMessage.content 类型
 * 为 `(TextContent | ThinkingContent | ToolCall)[]` —— 数据模型上不存在
 * assistant 图片块，模型产出的图片必然经 toolResult 返回（入口 2 覆盖）。
 * 因此入口枚举是完备的。
 *
 * 目标：所有路径的历史媒体在下一轮 provider 请求中 = 0 字节。
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { createE2EHarness } from "./harness.js";
import { fakeImageBytes } from "../helpers.js";

/** 模拟浏览器截图工具：toolResult 携带图片（E7 入口 2） */
const screenshotBytes = fakeImageBytes(701, 40 * 1024);
const screenshotFactory = (pi: ExtensionAPI): void => {
  pi.registerTool({
    name: "fake_screenshot",
    label: "Fake Screenshot",
    description: "Capture a fake browser screenshot (returns an image)",
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "image" as const,
            data: screenshotBytes.toString("base64"),
            mimeType: "image/png",
          },
        ],
        details: {},
      };
    },
  });
};

describe("E7: 多入口媒体泄漏", () => {
  it("入口 2：toolResult 图片 —— 当前轮可见，下一轮 0 字节", async () => {
    const harness = await createE2EHarness({
      withPlugin: true,
      extraFactories: [screenshotFactory],
    });
    try {
      harness.setResponses([
        // 模型决定截图（工具调用）
        fauxAssistantMessage([fauxToolCall("fake_screenshot", {})], { stopReason: "toolUse" }),
        // 工具返回图片后，模型确认（此时仍在当前轮：截图应可见）
        fauxAssistantMessage("截图完成"),
        // 下一轮
        fauxAssistantMessage("继续工作"),
      ]);

      await harness.session.prompt("帮我截个图看看当前页面");
      await harness.session.prompt("好的，继续修改样式");

      // 请求序列：turn1 第一次（无图）→ turn1 第二次（toolResult 图，当前轮）→ turn2（应为 0）
      expect(harness.captured.length).toBeGreaterThanOrEqual(3);

      const withScreenshot = harness.captured[1];
      expect(withScreenshot.mediaBytes).toBeGreaterThan(0); // 当前轮 toolResult 图允许

      const nextTurn = harness.captured[2];
      expect(nextTurn.mediaBytes).toBe(0); // 下一轮：历史 toolResult 图被替换

      // 替换文本进入上下文
      expect(JSON.stringify(nextTurn.context)).toContain("[Artifact Reference]");
    } finally {
      await harness.cleanup();
    }
  });

  it("入口 1+2 混合：用户图 + 工具图同轮上传，下一轮全部归零", async () => {
    const userImage = {
      type: "image" as const,
      data: fakeImageBytes(702, 32 * 1024).toString("base64"),
      mimeType: "image/png",
    };
    const harness = await createE2EHarness({
      withPlugin: true,
      extraFactories: [screenshotFactory],
    });
    try {
      harness.setResponses([
        fauxAssistantMessage([fauxToolCall("fake_screenshot", {})], { stopReason: "toolUse" }),
        fauxAssistantMessage("都收到了"),
        fauxAssistantMessage("继续"),
      ]);

      await harness.session.prompt("参考这张设计稿，先截图当前实现", { images: [userImage] });
      await harness.session.prompt("对比一下差异");

      expect(harness.captured.length).toBeGreaterThanOrEqual(3);
      // 当前轮：用户图 + 截图都在
      expect(harness.captured[0].mediaBytes).toBeGreaterThan(0);
      expect(harness.captured[1].mediaBytes).toBeGreaterThan(0);
      // 下一轮：两个入口的图都归零
      expect(harness.captured[2].mediaBytes).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });
});
