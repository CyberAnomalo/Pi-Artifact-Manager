/**
 * L2 — 真实 CLI + Mock Provider（不需要真实 AI API）。
 *
 * 证据链比 L1 更硬：请求经过真实 pi CLI 进程、真实扩展加载、
 * 真实 HTTP 序列化 —— mock server 落盘的就是线上会发出的字节。
 *
 * A/B 设计：
 *   实验组（带插件）：turn1 有图，turn2 文本 → HTTP 请求 2 媒体字节 = 0
 *   基线组（无插件）：同样剧本 → HTTP 请求 2 媒体字节 > 0（缺陷真实存在）
 *
 * 定位：生产行为验证（核心证明仍由 L1 承担）。
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { startMockProviderServer, type MockServerHandle } from "./mock-server.js";
import { makeRealPng, countMediaBytesInPayload } from "../helpers.js";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
const CLI_PATH = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
const PLUGIN_ENTRY = path.join(REPO_ROOT, "index.ts");
const PROVIDER_EXT = path.join(REPO_ROOT, "tests", "l2", "provider-extension.ts");

let workDir: string;
let server: MockServerHandle;

beforeAll(async () => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-l2-"));
  server = await startMockProviderServer(workDir);
});

afterAll(async () => {
  await server.close();
  try {
    fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {}
});

interface RunOptions {
  sessionId: string;
  prompt: string;
  withPlugin: boolean;
  imageFile?: string;
}

/** 运行一次真实 pi CLI（print 模式）。 */
function runPi(options: RunOptions): Promise<{ code: number; stdout: string; stderr: string }> {
  const args = [CLI_PATH, "-p", options.prompt, "--model", "mock-l2/mock-vision"];
  if (options.imageFile) args.push(`@${options.imageFile}`);
  args.push("-e", PROVIDER_EXT);
  if (options.withPlugin) args.push("-e", PLUGIN_ENTRY);
  args.push("--session-id", options.sessionId, "--session-dir", path.join(workDir, "sessions"));

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: workDir,
      // print 模式会读 piped stdin：必须断开，否则子进程等 EOF 挂起
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        L2_MOCK_PORT: String(server.port),
        // 隔离 agent 目录：不触碰用户 ~/.pi，避免 trust/settings 干扰
        PI_CODING_AGENT_DIR: path.join(workDir, "agent-dir"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("L2: 真实 CLI + Mock Provider（HTTP 出口断言）", () => {
  it(
    "实验组（带插件）：turn2 的 HTTP 请求 0 媒体字节",
    async () => {
      // 准备真实 PNG（pi CLI 按 magic bytes 识别图片附件）
      const imageFile = path.join(workDir, "shot.png");
      fs.writeFileSync(imageFile, makeRealPng(200, 200, 1101));

      const sessionId = `l2-plugin-${Date.now()}`;
      const before = server.readRequests().length;

      // turn 1: 带图
      const r1 = await runPi({ sessionId, prompt: "看这张图", withPlugin: true, imageFile });
      expect(r1.code).toBe(0);

      // turn 2: 纯文本（同一 session）
      const r2 = await runPi({ sessionId, prompt: "继续优化按钮", withPlugin: true });
      expect(r2.code).toBe(0);

      const requests = server.readRequests().slice(before);
      expect(requests.length).toBeGreaterThanOrEqual(2);

      const turn1 = requests[0].body;
      const turn2 = requests[requests.length - 1].body;

      // turn 1：当前轮图片允许（HTTP 请求携带媒体）
      expect(countMediaBytesInPayload(turn1)).toBeGreaterThan(0);
      // turn 2：历史媒体 0 字节（核心断言 —— 真实 HTTP 出口）
      expect(countMediaBytesInPayload(turn2)).toBe(0);
      // 引用文本替代了图片
      expect(JSON.stringify(turn2)).toContain("[Artifact Reference]");
    },
    120_000,
  );

  it(
    "基线组（无插件）：turn2 的 HTTP 请求重放图片 —— 生产缺陷确认",
    async () => {
      const imageFile = path.join(workDir, "shot-baseline.png");
      fs.writeFileSync(imageFile, makeRealPng(200, 200, 1102));

      const sessionId = `l2-baseline-${Date.now()}`;
      const before = server.readRequests().length;

      const r1 = await runPi({ sessionId, prompt: "看这张图", withPlugin: false, imageFile });
      expect(r1.code).toBe(0);
      const r2 = await runPi({ sessionId, prompt: "继续优化按钮", withPlugin: false });
      expect(r2.code).toBe(0);

      const requests = server.readRequests().slice(before);
      expect(requests.length).toBeGreaterThanOrEqual(2);

      const turn2 = requests[requests.length - 1].body;
      // 失败基线：无插件时历史图片重放到每一次 HTTP 请求
      expect(countMediaBytesInPayload(turn2)).toBeGreaterThan(0);
    },
    120_000,
  );
});
