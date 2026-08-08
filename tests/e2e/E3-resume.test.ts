/**
 * E3 — Session Resume（Req 2，真实 pi 运行时）。
 *
 * MVP 完成标准 Requirement 2：
 *   关闭 pi 再打开 → resume 成功；blob 字节不随 resume 进入请求。
 *
 * 流程：
 *   会话 1（fileSession）：上传图片 + 一轮文本 → 落盘 → 释放
 *   会话 2（SessionManager.open 同一文件）：纯文本轮 → provider 请求媒体 = 0
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createE2EHarness } from "./harness.js";
import { fakeImageBytes } from "../helpers.js";

describe("E3: Resume 后不重放历史媒体", () => {
  it("重启后纯文本轮：provider 请求媒体字节 = 0", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-e3-"));

    // ── 会话 1：上传图片 + 一轮文本，然后“退出 pi” ──
    const image = {
      type: "image" as const,
      data: fakeImageBytes(801, 32 * 1024).toString("base64"),
      mimeType: "image/png",
    };
    const h1 = await createE2EHarness({ withPlugin: true, fileSession: true, workDir });
    let sessionFile: string;
    try {
      h1.setResponses([fauxAssistantMessage("收到图片"), fauxAssistantMessage("好的")]);
      await h1.session.prompt("看这张图", { images: [image] });
      await h1.session.prompt("继续");
      sessionFile = h1.sessionManager.getSessionFile();
      expect(fs.existsSync(sessionFile)).toBe(true);
    } finally {
      await h1.cleanup();
    }

    // ── 会话 2：模拟重启 pi，resume 同一会话文件 ──
    const sm2 = SessionManager.open(sessionFile, undefined, workDir);
    const h2 = await createE2EHarness({ withPlugin: true, sessionManager: sm2, workDir });
    try {
      h2.setResponses([fauxAssistantMessage("resume 后的回复")]);
      await h2.session.prompt("继续优化按钮");

      expect(h2.captured.length).toBeGreaterThanOrEqual(1);
      // resume 后的请求：历史图片不得重放
      for (const req of h2.captured) {
        expect(req.mediaBytes).toBe(0);
      }
      // 上下文中保留的是 artifact 引用（会话记忆未丢失）
      const json = JSON.stringify(h2.captured[0].context);
      expect(json).toContain("[Artifact Reference]");
      expect(json).toMatch(/artifact_[0-9a-f]{7}/);
    } finally {
      await h2.cleanup();
      try {
        fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {}
    }
  });
});
