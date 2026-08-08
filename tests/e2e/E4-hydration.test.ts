/**
 * E4 — Artifact Hydration（Req 3，真实 pi 运行时）。
 *
 * MVP 完成标准 Requirement 3：artifact_get() 可恢复图片。
 *
 * 注意（实验设计修正）：不断言「模型会主动调 artifact_get」——
 * 工具选择是模型行为，不是系统正确性。这里用脚本化 faux 响应
 * 模拟模型显式调用，验证系统侧链路：
 *   SQLite → Blob → toolResult 图片 → guard 放行 → provider 收到原图
 */

import { describe, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createE2EHarness } from "./harness.js";
import { fakeImageBytes, countMediaBytesInPayload } from "../helpers.js";
import { sha256Hex } from "../../src/core/blob.js";
import { makeArtifactId } from "../../src/core/artifact.js";

describe("E4: artifact_get 重载（hydration）", () => {
  it("显式 artifact_get 后图片重新进入当前轮请求，且字节级一致", async () => {
    const imageBytes = fakeImageBytes(901, 28 * 1024);
    const artifactId = makeArtifactId(sha256Hex(imageBytes)); // 确定性预计算

    const harness = await createE2EHarness({ withPlugin: true });
    try {
      harness.setResponses([
        fauxAssistantMessage("收到图片"), // turn 1
        fauxAssistantMessage("好的"), // turn 2（图片转历史）
        // turn 3：模型显式调用 artifact_get
        fauxAssistantMessage([fauxToolCall("artifact_get", { id: artifactId })], { stopReason: "toolUse" }),
        fauxAssistantMessage("图片已重载"), // 工具结果后的确认
        fauxAssistantMessage("继续"), // turn 4：又转历史
      ]);

      const image = {
        type: "image" as const,
        data: imageBytes.toString("base64"),
        mimeType: "image/png",
      };

      await harness.session.prompt("看这张图", { images: [image] }); // turn 1
      await harness.session.prompt("继续改代码"); // turn 2：历史化
      await harness.session.prompt("重新加载那张图"); // turn 3：hydration
      await harness.session.prompt("好的继续"); // turn 4：再历史化

      expect(harness.captured.length).toBeGreaterThanOrEqual(5);

      // turn 2 请求：0 媒体（已历史化）
      expect(harness.captured[1].mediaBytes).toBe(0);

      // turn 3 第一次请求（工具调用前）：仍为 0
      expect(harness.captured[2].mediaBytes).toBe(0);

      // turn 3 工具执行后的请求：图片恢复（hydration 放行）
      const hydrated = harness.captured[3];
      expect(hydrated.mediaBytes).toBeGreaterThan(0);
      // 字节级一致：恢复的就是原图（sha256 相同）
      expect(hydrated.mediaBytes).toBe(harness.captured[0].mediaBytes);
      const hydratedJson = JSON.stringify(hydrated.context);
      expect(hydratedJson).toContain(imageBytes.toString("base64").slice(0, 64));

      // turn 4：hydration 的图片再次转历史，0 媒体
      const after = harness.captured.slice(4);
      expect(after.length).toBeGreaterThanOrEqual(1);
      for (const req of after) {
        expect(countMediaBytesInPayload(req.context)).toBe(0);
      }
    } finally {
      await harness.cleanup();
    }
  });

  /**
   * L3 评审反馈（S3 双图比较）的硬断言版本：
   * 两个独立 artifact 先后 artifact_get 后必须能同一请求受控物化，
   * 且比较完成后的后续请求全部冷却——不依赖人工肉眼判断。
   */
  it("双图 hydration：同请求物化两张图，比较后双双冷却", async () => {
    const bytesA = fakeImageBytes(902, 20 * 1024);
    const bytesB = fakeImageBytes(903, 22 * 1024);
    const idA = makeArtifactId(sha256Hex(bytesA));
    const idB = makeArtifactId(sha256Hex(bytesB));

    const harness = await createE2EHarness({ withPlugin: true });
    try {
      harness.setResponses([
        fauxAssistantMessage("收到两张图"), // turn 1：上传 A(before) + B(after)
        fauxAssistantMessage("好的"), // turn 2：两图转历史
        // turn 3（同一轮工具循环）：先取 A → 再取 B → 同请求比较
        fauxAssistantMessage([fauxToolCall("artifact_get", { id: idA })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxToolCall("artifact_get", { id: idB })], { stopReason: "toolUse" }),
        fauxAssistantMessage("比较结果：..."), // turn 3 最后请求：同含两图
        fauxAssistantMessage("继续"), // turn 4：纯文本 → 必须 0 媒体
      ]);

      const mkImage = (bytes: Buffer) => ({
        type: "image" as const,
        data: bytes.toString("base64"),
        mimeType: "image/png",
      });

      await harness.session.prompt("这张是修改前版本，这张是修改后版本", {
        images: [mkImage(bytesA), mkImage(bytesB)],
      }); // turn 1
      await harness.session.prompt("先记下来"); // turn 2
      await harness.session.prompt("重新加载修改前和修改后的截图，对比列出变化"); // turn 3
      await harness.session.prompt("好的继续改代码"); // turn 4

      const prefixA = bytesA.toString("base64").slice(0, 64);
      const prefixB = bytesB.toString("base64").slice(0, 64);

      // 找到比较轮请求：同时含两图、且不是上传轮本身（含 toolCall 历史）
      const both = harness.captured.filter((req, idx) => {
        if (idx === 0) return false; // 上传轮合法携带两图，不算 hydration
        const json = JSON.stringify(req.context);
        return json.includes(prefixA) && json.includes(prefixB);
      });
      expect(both.length).toBeGreaterThanOrEqual(1);
      for (const req of both) {
        const json = JSON.stringify(req.context);
        expect(json).toContain(prefixA); // A 字节级一致
        expect(json).toContain(prefixB); // B 字节级一致
      }

      // 比较请求（最后一次双图共现）之后的所有请求：全部 0 媒体（双双冷却）
      const compareReq = both[both.length - 1];
      const tail = harness.captured.slice(compareReq.index + 1);
      expect(tail.length).toBeGreaterThanOrEqual(1);
      for (const req of tail) {
        expect(countMediaBytesInPayload(req.context)).toBe(0);
      }
    } finally {
      await harness.cleanup();
    }
  });
});
