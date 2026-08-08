/**
 * E8 — Payload Guard 真实参与测试（真实 pi 运行时 + 真实事件链）。
 *
 * 背景：faux provider 内置实现跳过 streamOptions.onPayload，导致
 * before_provider_request（guard）在 L1 从未参与（覆盖缺口）。
 * harness 已手动对齐真实适配器行为（请求前先走 onPayload），
 * 本测试在真实事件链上给出 guard 参与的硬证据：
 *
 *   泄漏来源：一个扩展通过 context 钩子返回的消息里夹带历史图片 ——
 *   且使用 transformContext 不识别的 OpenAI image_url 形态（data URI），
 *   于是 context 层放行 → 只能由 guard（最后防线）在 provider 请求前剥离。
 *   这正是 guard 与 context 钩子形态覆盖差异的兜底场景（fail-closed）。
 *
 * 注：实测扩展事件顺序为「插件先于内联测试扩展」，因此泄漏注入只能
 * 发生在插件钩子之后（context 返回值链），与真实泄漏路径一致。
 */

import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createE2EHarness } from "./harness.js";
import { fakeImageBytes } from "../helpers.js";
import { sha256Hex } from "../../src/core/blob.js";
import { makeArtifactId } from "../../src/core/artifact.js";

describe("E8: Payload Guard 在 L1 真实事件链中的拦截", () => {
  it("context 层漏过的 image_url 历史图被 guard 剥离：provider 端 0 媒体 + 占位文本", async () => {
    const bytes = fakeImageBytes(801, 24 * 1024);
    const base64 = bytes.toString("base64");
    const expectedId = makeArtifactId(sha256Hex(bytes));
    const dataUri = `data:image/png;base64,${base64}`;

    // 泄漏注入器：context 钩子在插件 transformContext 之后执行（扩展顺序实测），
    // 把已归档图片以 OpenAI image_url 形态塞回历史消息 ——
    // transformContext 只认 {type:"image"} 块，此形态穿透 context 层
    const leakInjector = (pi: ExtensionAPI): void => {
      pi.on("context", (event) => {
        const messages = (event as unknown as { messages: unknown[] }).messages;
        if (!Array.isArray(messages) || messages.length === 0) return;
        const first = messages[0] as { content?: unknown[] };
        if (!Array.isArray(first.content)) return;
        first.content.push({
          type: "image_url",
          image_url: { url: dataUri },
        });
        // biome-ignore lint/suspicious/noExplicitAny: ContextEventResult 未导出
        return { messages } as any;
      });
    };

    const harness = await createE2EHarness({ withPlugin: true, extraFactories: [leakInjector] });
    try {
      harness.setResponses([
        fauxAssistantMessage("收到图片"), // turn 1：上传（入库 + 当前轮授权）
        fauxAssistantMessage("继续工作"), // turn 2：注入器泄漏 → guard 拦截
      ]);

      await harness.session.prompt("看这张图", {
        images: [{ type: "image", data: base64, mimeType: "image/png" }],
      });
      await harness.session.prompt("好的继续");

      expect(harness.captured.length).toBeGreaterThanOrEqual(2);

      // 上传轮：当前轮图片合法放行（guard 不误杀）
      expect(harness.captured[0].mediaBytes).toBeGreaterThan(0);

      // 泄漏轮：注入的 image_url 图被 guard 剥离 —— provider 端 0 媒体字节
      const leaked = harness.captured[1];
      expect(leaked.mediaBytes).toBe(0);

      // 占位文本带已知 artifact 引用（fail-closed 且可恢复提示）
      const json = JSON.stringify(leaked.context);
      expect(json).toContain("Historical media blocked");
      expect(json).toContain(expectedId);
      expect(json).toContain("Use artifact_get to reload");
      // 原始图片字节绝不到达 provider
      expect(json.includes(base64.slice(0, 64))).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });
});
