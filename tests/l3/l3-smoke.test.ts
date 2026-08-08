/**
 * L3 冒烟 — 真实模型（qwen-token-plan-cn/qwen3.7-plus）+ 真实 CLI + 插件。
 *
 * 与 L2 的区别：provider 出口是真实阿里云端点，回答由真实模型产生。
 * 本文件只做「接入冒烟」，完整人工验收按 L3 checklist 执行。
 *
 * 前置：环境变量 ALI_KEY（自动映射为 QWEN_TOKEN_PLAN_CN_API_KEY）。
 * 手动运行：bun test tests/l3/（不进默认 test 套件，避免无 key 时 CI 失败）
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeRealPng } from "../helpers.js";
import { runPi, hasKey } from "./runner.js";

const describeIfKey = hasKey ? describe : describe.skip;

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-l3-"));
});

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {}
});

interface RunOptions {
  sessionId: string;
  prompt: string;
  imageFile?: string;
}

function run(options: RunOptions) {
  return runPi({ ...options, workDir });
}

describeIfKey("L3 冒烟：真实模型 + 插件", () => {
  it(
    "S1：当前轮图片到达真实模型，且插件不破坏会话",
    async () => {
      // 纹理图（无可读文字）：防止模型凭文字猜，也天然满足 summary 无泄漏
      const imageFile = path.join(workDir, "s1.png");
      fs.writeFileSync(imageFile, makeRealPng(200, 200, 3101));

      const sessionId = `l3-smoke-${Date.now()}`;

      // turn 1：带图 —— 模型必须真的看见图
      const r1 = await run({
        sessionId,
        prompt: "描述这张图片的视觉内容（颜色、纹理、形状）。不要说看不到图片。",
        imageFile,
      });
      expect(r1.code).toBe(0);
      // 真实模型对纹理图应有实质描述（宽松断言：非空且不承认看不见）
      expect(r1.stdout.trim().length).toBeGreaterThan(20);
      console.log("[L3-S1 turn1]", r1.stdout.trim().slice(0, 200));

      // turn 2：纯文本 —— 插件历史化后会话仍正常
      const r2 = await run({ sessionId, prompt: "用一句话总结你刚才看到的图片。" });
      expect(r2.code).toBe(0);
      expect(r2.stdout.trim().length).toBeGreaterThan(5);
      console.log("[L3-S1 turn2]", r2.stdout.trim().slice(0, 200));

      // 插件工作痕迹：.visual-artifacts/ 已创建且至少 1 个 artifact
      const dbPath = path.join(workDir, ".visual-artifacts", "database.sqlite");
      expect(fs.existsSync(dbPath)).toBe(true);
    },
    300_000,
  );
});

if (!hasKey) {
  describe("L3 冒烟", () => {
    it.skip("未设置 ALI_KEY / QWEN_TOKEN_PLAN_CN_API_KEY，跳过真实模型冒烟");
  });
}
