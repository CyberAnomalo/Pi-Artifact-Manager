/**
 * E5 — 对抗测试（真实 pi 运行时）。
 *
 * 1. 同轮多次 provider 请求（工具循环 / retry 语义）：
 *    MediaPolicy 的 turn boundary 保证同一 turn 内的所有请求
 *    都允许当前轮图片——不会因为第二次请求误判为历史媒体（fail-closed
 *    但不过度拦截）。
 *
 * 2. Compaction 场景：
 *    压缩后上下文重建，历史媒体不得复活（Req 4 的 compaction 路径）。
 */

import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createE2EHarness } from "./harness.js";
import { fakeImageBytes } from "../helpers.js";

describe("E5: 对抗测试", () => {
  it("同轮多次请求：当前轮图片在 turn 内所有请求中保持允许", async () => {
    const harness = await createE2EHarness({ withPlugin: true });
    try {
      harness.setResponses([
        // 请求 1 的响应：模型先调 artifact_list（制造同轮第二次请求）
        fauxAssistantMessage([fauxToolCall("artifact_list", {})], { stopReason: "toolUse" }),
        // 请求 2（工具结果后）的响应：结束当前轮
        fauxAssistantMessage("本轮完成"),
        // turn 2
        fauxAssistantMessage("下一轮"),
      ]);

      const image = {
        type: "image" as const,
        data: fakeImageBytes(501, 24 * 1024).toString("base64"),
        mimeType: "image/png",
      };

      // turn 1：带图 prompt → 请求1（模型看）→ 工具 → 请求2（同轮）
      await harness.session.prompt("看这张图并列出 artifacts", { images: [image] });
      // turn 2：纯文本
      await harness.session.prompt("继续");

      expect(harness.captured.length).toBeGreaterThanOrEqual(3);

      // 关键断言：同一 turn 内的两次请求都携带当前轮图片
      // （agent_end 才清空 allowedHashes；retry/工具循环内的 turn_end 不清空）
      expect(harness.captured[0].mediaBytes).toBeGreaterThan(0);
      expect(harness.captured[1].mediaBytes).toBeGreaterThan(0);
      expect(harness.captured[1].mediaBytes).toBe(harness.captured[0].mediaBytes);

      // turn 2：转历史，0 字节
      for (const req of harness.captured.slice(2)) {
        expect(req.mediaBytes).toBe(0);
      }
    } finally {
      await harness.cleanup();
    }
  });

  it("compact 后：历史媒体不复活，后续请求 0 字节", async () => {
    // keepRecentTokens=0 让小会话也能找到压缩切点（默认 20000 对假消息太大）
    const harness = await createE2EHarness({
      withPlugin: true,
      settings: { compaction: { keepRecentTokens: 0 } },
    });
    try {
      harness.setResponses([
        fauxAssistantMessage("收到图片"),
        fauxAssistantMessage("好的继续"),
        fauxAssistantMessage("对话摘要：用户上传了一张 UI 截图，讨论了按钮优化。"), // compaction 摘要
        fauxAssistantMessage("压缩后继续"), // compact 后第一轮
      ]);

      const image = {
        type: "image" as const,
        data: fakeImageBytes(502, 32 * 1024).toString("base64"),
        mimeType: "image/png",
      };

      await harness.session.prompt("看这张图", { images: [image] });
      await harness.session.prompt("继续改代码");

      // 触发压缩（真实 compaction 流程）
      await (harness.session as unknown as { compact(): Promise<unknown> }).compact();

      // 压缩后第一轮：历史图片不得随 compaction 复活
      await harness.session.prompt("压缩后继续");

      const lastRequest = harness.captured[harness.captured.length - 1];
      expect(lastRequest.mediaBytes).toBe(0);
    } finally {
      await harness.cleanup();
    }
  });
});
