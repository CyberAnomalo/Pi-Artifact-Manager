/**
 * L3 共享 runner — 真实 pi CLI + 真实模型（qwen-token-plan-cn/qwen3.7-plus）。
 *
 * 环境变量：ALI_KEY（自动映射 QWEN_TOKEN_PLAN_CN_API_KEY）。
 * 无 key 时各套件自动 skip，不进默认 test 脚本。
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
export const CLI_PATH = path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
export const PLUGIN_ENTRY = path.join(REPO_ROOT, "index.ts");
export const MODEL = "qwen-token-plan-cn/qwen3.7-plus";

export const apiKey = process.env.ALI_KEY || process.env.QWEN_TOKEN_PLAN_CN_API_KEY || "";
export const hasKey = Boolean(apiKey);

export interface L3RunOptions {
  workDir: string;
  sessionId: string;
  prompt: string;
  imageFile?: string;
  /** false = 不加载插件（基线对照） */
  withPlugin?: boolean;
}

export interface L3RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** 秒 */
  durationSec: number;
}

/** 运行一次真实 pi CLI（print 模式，多轮用同一 sessionId 续接）。 */
export function runPi(options: L3RunOptions): Promise<L3RunResult> {
  const withPlugin = options.withPlugin ?? true;
  const args = [CLI_PATH, "-p", options.prompt, "--model", MODEL];
  if (options.imageFile) args.push(`@${options.imageFile}`);
  if (withPlugin) args.push("-e", PLUGIN_ENTRY);
  args.push("--session-id", options.sessionId, "--session-dir", path.join(options.workDir, "sessions"));

  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: options.workDir,
      // print 模式会读 piped stdin：必须断开，否则子进程等 EOF 挂起
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        QWEN_TOKEN_PLAN_CN_API_KEY: apiKey,
        // 隔离 agent 目录：不触碰用户 ~/.pi
        PI_CODING_AGENT_DIR: path.join(options.workDir, "agent-dir"),
        PI_SKIP_VERSION_CHECK: "1",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr, durationSec: (Date.now() - started) / 1000 }),
    );
  });
}

/** agent-dir/settings.json 写入（如 S4B 强制 compact 的 compaction 配置）。 */
export function writeAgentSettings(workDir: string, settings: Record<string, unknown>): void {
  const dir = path.join(workDir, "agent-dir");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
}

/** 只读打开 .visual-artifacts/database.sqlite 统计 artifact 数（跨进程只读，避免 WAL 冲突）。 */
export function countArtifactsInDb(workDir: string): number {
  const dbPath = path.join(workDir, ".visual-artifacts", "database.sqlite");
  if (!fs.existsSync(dbPath)) return -1;
  // 双后端：bun 无 node:sqlite（与 src/core/database.ts 同策略）
  if ((globalThis as { Bun?: unknown }).Bun) {
    // biome-ignore lint/suspicious/noExplicitAny: bun:sqlite 类型
    const { Database } = require("bun:sqlite") as any;
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  }
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM artifacts").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** 编辑距离（码字符集内比较用，去连字符后等长）。 */
function codeEditDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/**
 * 分类助手：模型输出中是否出现指定验证码 / 是否承认看不到。
 * near-miss = 编辑距离≤2 的形近误读（S↔5、B↔2 等，实测 L3 复测 3/3 均≤1）——
 * 证明图片确实被加载，属于视觉 OCR 噪声层；与「凭空编造」（距离大或
 * 无码）严格区分，对应 L3 修订方案的分类细化要求。
 */
export type CodeVerdict = "recovered" | "near-miss" | "hallucinated" | "honest-decline" | "unclear";
export function classifyCodeAnswer(stdout: string, expectedCode: string): CodeVerdict {
  const text = stdout.toUpperCase();
  if (text.includes(expectedCode)) return "recovered";
  // 承认看不到（诚实退化，可接受）
  if (/看不到|无法看到|没有图片|无法访问|已经不在|看不到图片|无法直接查看/.test(stdout)) return "honest-decline";
  // 出现形如 XXXX-XXXX 的码：按编辑距离区分形近误读与编造
  const codeLike = text.match(/[2-9A-HJ-KM-NP-Z]{4}-[2-9A-HJ-KM-NP-Z]{4}/g) ?? [];
  if (codeLike.length > 0) {
    const expected = expectedCode.replace("-", "");
    const best = Math.min(...codeLike.map((c) => codeEditDistance(expected, c.replace("-", ""))));
    return best <= 2 ? "near-miss" : "hallucinated";
  }
  return "unclear";
}
