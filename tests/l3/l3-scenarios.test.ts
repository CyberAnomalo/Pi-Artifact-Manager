/**
 * L3 场景套件 — 真实模型（qwen-token-plan-cn/qwen3.7-plus）+ 真实 CLI + 插件。
 *
 * 设计原则（L3 评审修订版）：
 *   - 硬断言只落在系统侧不变量：进程退出码、artifact store 状态
 *   - 模型行为（是否主动调 artifact_get、是否编造）只分类记录，不作通过条件
 *   - S2 防作弊：验证码只渲染在像素里，summary 恒为 null，模型无法从引用文本作弊
 *
 * 场景：
 *   S2  历史单图恢复（验证码）— 机器可恢复性 + 幻觉检测
 *   S3  历史双图比较（A/B 固定标签）— 受控多图物化 + 对应关系保持
 *   S4A Resume — 跨进程持续性
 *   S4B Compact — 显式触发压缩后的持续性
 *
 * 运行：npm run test:l3（消耗真实额度，不进默认 test 脚本）
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeTextPng, randomVerificationCode } from "../helpers.js";
import { runPi, hasKey, writeAgentSettings, countArtifactsInDb, classifyCodeAnswer } from "./runner.js";

const describeIfKey = hasKey ? describe : describe.skip;
const TURN_TIMEOUT = 600_000;

let workDir: string;

beforeAll(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-l3s-"));
});

afterAll(() => {
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {}
});

function run(sessionId: string, prompt: string, imageFile?: string) {
  return runPi({ workDir, sessionId, prompt, imageFile });
}

describeIfKey("L3 场景：真实模型行为观察（系统侧硬断言 + 体验分类记录）", () => {
  it(
    "S2：历史单图恢复 — 验证码只存在于像素，跨轮后模型如何取回",
    async () => {
      const code = randomVerificationCode();
      const imageFile = path.join(workDir, "s2.png");
      fs.writeFileSync(imageFile, makeTextPng(["ERROR SCREEN", `CODE: ${code}`]));
      const sessionId = `l3-s2-${Date.now()}`;

      // turn 1：上传 + 中性确认（不要求读码，避免把码写进模型近期记忆之外的地方）
      const r1 = await run(sessionId, "确认你收到了一张图片，一句话说明它大致是什么（不要读出其中的验证码）。", imageFile);
      expect(r1.code).toBe(0);

      // turn 2：填充轮（图片转历史）
      const r2 = await run(sessionId, "好的。请回答：1+1 等于几？只回答数字。");
      expect(r2.code).toBe(0);

      // turn 3：跨轮取回 —— 核心观察点
      const r3 = await run(sessionId, "请重新查看我之前发的那张截图，读出其中的验证码（格式 XXXX-XXXX）。如果无法查看，请明确说明。");
      expect(r3.code).toBe(0);

      // 系统侧硬断言：图片确实入库
      expect(countArtifactsInDb(workDir)).toBeGreaterThanOrEqual(1);

      // 体验分类（不作通过条件，输出供人工判读）
      const verdict = classifyCodeAnswer(r3.stdout, code);
      console.log(`[L3-S2] code=${code} verdict=${verdict}`);
      console.log(`[L3-S2] turn1(${r1.durationSec.toFixed(1)}s):`, r1.stdout.trim().slice(0, 160));
      console.log(`[L3-S2] turn3(${r3.durationSec.toFixed(1)}s):`, r3.stdout.trim().slice(0, 400));
      if (verdict === "hallucinated") {
        console.warn("[L3-S2] ⚠ 模型编造了验证码 —— 严重体验缺陷，记入验收记录");
      }
    },
    TURN_TIMEOUT,
  );

  it(
    "S3：历史双图比较 — 固定标签 A/B，比较后关系是否保持",
    async () => {
      // 两张视觉可区分的图（大字标签），A/B 关系由用户文字固定
      const fileA = path.join(workDir, "s3-a.png");
      const fileB = path.join(workDir, "s3-b.png");
      fs.writeFileSync(fileA, makeTextPng(["VERSION A", "BEFORE CHANGE"]));
      fs.writeFileSync(fileB, makeTextPng(["VERSION B", "AFTER CHANGE"]));
      const sessionId = `l3-s3-${Date.now()}`;

      // turn 1：一次上传两张（同条消息 → 天然同组），显式标签
      const r1 = await run(
        sessionId,
        "我发了两张图：第一张是修改前版本（A），第二张是修改后版本（B）。确认你已收到并记住这个对应关系，不要描述细节。",
        fileA,
      );
      expect(r1.code).toBe(0);
      // 注意：pi CLI @file 单轮多图受限时退化为顺序附件；第二张单独补发以保证入库
      const r1b = await run(sessionId, "补充：这是修改后版本（B）。确认收到即可。", fileB);
      expect(r1b.code).toBe(0);

      // turn 2：填充轮
      const r2 = await run(sessionId, "回答：2+2 等于几？只回答数字。");
      expect(r2.code).toBe(0);

      // turn 3：跨轮比较
      const r3 = await run(sessionId, "重新加载我之前的修改前（A）和修改后（B）两张截图，指出它们的可见差异。");
      expect(r3.code).toBe(0);

      // 系统侧硬断言：两张图都入库
      expect(countArtifactsInDb(workDir)).toBeGreaterThanOrEqual(2);

      // 体验记录：A/B 对应关系是否保持（人工判读）
      const out = r3.stdout;
      console.log(`[L3-S3] mentionsA=${/版本\s*A|VERSION A|第一张/.test(out)} mentionsB=${/版本\s*B|VERSION B|第二张/.test(out)}`);
      console.log(`[L3-S3] turn3(${r3.durationSec.toFixed(1)}s):`, out.trim().slice(0, 400));
    },
    TURN_TIMEOUT,
  );

  it(
    "S4A：Resume — 退出后同一 session 恢复，历史图仍可取回",
    async () => {
      const code = randomVerificationCode();
      const imageFile = path.join(workDir, "s4a.png");
      fs.writeFileSync(imageFile, makeTextPng([`TOKEN ${code}`]));
      const sessionId = `l3-s4a-${Date.now()}`;

      const r1 = await run(sessionId, "确认收到图片，一句话即可。", imageFile);
      expect(r1.code).toBe(0);

      // —— 进程退出（runPi 每轮本就是新进程，等价于 resume）——
      // turn 2：新进程 + 同 sessionId，直接要求跨进程取回
      const r2 = await run(sessionId, "重新查看我上一轮发的截图，读出其中的 TOKEN 验证码（格式 XXXX-XXXX）。如果无法查看，请明确说明。");
      expect(r2.code).toBe(0);

      expect(countArtifactsInDb(workDir)).toBeGreaterThanOrEqual(1);

      const verdict = classifyCodeAnswer(r2.stdout, code);
      console.log(`[L3-S4A] code=${code} verdict=${verdict}`);
      console.log(`[L3-S4A] turn2(${r2.durationSec.toFixed(1)}s):`, r2.stdout.trim().slice(0, 400));
    },
    TURN_TIMEOUT,
  );

  it(
    "S4B：Compact — 显式压缩后引用保留、图片仍可取回",
    async () => {
      // 独立目录 + 强制 compact 设置（keepRecentTokens=0 → 每轮评估压缩）
      const compactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-l3s-compact-"));
      writeAgentSettings(compactDir, { compaction: { enabled: true, keepRecentTokens: 0 } });

      const code = randomVerificationCode();
      const imageFile = path.join(compactDir, "s4b.png");
      fs.writeFileSync(imageFile, makeTextPng([`VERIFY ${code}`]));
      const sessionId = `l3-s4b-${Date.now()}`;

      const runC = (prompt: string, img?: string) =>
        runPi({ workDir: compactDir, sessionId, prompt, imageFile: img });

      const r1 = await runC("确认收到图片，一句话即可。", imageFile);
      expect(r1.code).toBe(0);
      const r2 = await runC("回答：3+3 等于几？只回答数字。");
      expect(r2.code).toBe(0);
      // 此时前两轮应已被压缩（keepRecentTokens=0）
      const r3 = await runC("重新查看我之前发的截图，读出其中的 VERIFY 验证码（格式 XXXX-XXXX）。如果无法查看，请明确说明。");
      expect(r3.code).toBe(0);

      expect(countArtifactsInDb(compactDir)).toBeGreaterThanOrEqual(1);

      const verdict = classifyCodeAnswer(r3.stdout, code);
      console.log(`[L3-S4B] code=${code} verdict=${verdict}`);
      console.log(`[L3-S4B] turn3(${r3.durationSec.toFixed(1)}s):`, r3.stdout.trim().slice(0, 400));
      // compact 是否真的发生：看会话目录内是否有 summary 痕迹（人工佐证，不断言）
      const sessionDir = path.join(compactDir, "sessions");
      console.log(`[L3-S4B] session files:`, fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir, { recursive: true }).slice(0, 10) : "none");

      try {
        fs.rmSync(compactDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {}
    },
    TURN_TIMEOUT,
  );
});

if (!hasKey) {
  describe("L3 场景", () => {
    it.skip("未设置 ALI_KEY / QWEN_TOKEN_PLAN_CN_API_KEY，跳过真实模型场景套件");
  });
}
