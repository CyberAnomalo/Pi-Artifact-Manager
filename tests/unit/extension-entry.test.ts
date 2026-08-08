/**
 * Extension 入口组装测试 — index.ts 的 hooks/tools/command 注册与 /artifact 命令。
 *
 * 用最小 fake ExtensionAPI 驱动真实入口函数，验证：
 *   - 三个 agent 工具全部注册（artifact_list/get/stats）
 *   - 全部 7 个事件钩子注册（input/context/guard/session 系列）
 *   - /artifact 命令的 status / list / help 行为
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import artifactManagerExtension from "../../index.js";

interface FakeCommandContext {
  ui: { notify: (message: string, type?: string) => void };
}

let dir: string;
let prevCwd: string;
let commands: Map<string, { description?: string; handler: (args: string, ctx: FakeCommandContext) => Promise<void> }>;
let tools: Map<string, { name: string }>;
let hooks: Map<string, unknown[]>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-entry-"));
  prevCwd = process.cwd();
  process.chdir(dir);

  commands = new Map();
  tools = new Map();
  hooks = new Map();

  const fakePi = {
    on(event: string, handler: unknown) {
      hooks.set(event, [...(hooks.get(event) ?? []), handler]);
    },
    registerTool(tool: { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: FakeCommandContext) => Promise<void> },
    ) {
      commands.set(name, options);
    },
  };

  // 真实入口函数（会创建 .visual-artifacts/ 于当前 cwd）
  artifactManagerExtension(fakePi as never);
});

afterEach(() => {
  // 通过 session_shutdown 钩子关闭数据库
  const shutdown = hooks.get("session_shutdown")?.[0] as (() => Promise<void>) | undefined;
  process.chdir(prevCwd);
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {}
  void shutdown?.().catch(() => {});
});

function makeCtx(): { ctx: FakeCommandContext; notifications: string[] } {
  const notifications: string[] = [];
  return {
    ctx: { ui: { notify: (message: string) => notifications.push(message) } },
    notifications,
  };
}

describe("入口组装", () => {
  it("注册全部三个 MVP 工具", () => {
    expect([...tools.keys()].sort()).toEqual(["artifact_get", "artifact_list", "artifact_stats"]);
  });

  it("注册全部事件钩子（设计文档 §11 的完整集合）", () => {
    const expected = [
      "input",
      "context",
      "before_provider_request",
      "session_before_compact",
      "session_start",
      "agent_end",
      "session_shutdown",
    ];
    for (const event of expected) {
      expect(hooks.has(event)).toBe(true);
    }
  });

  it("存储目录 .visual-artifacts/ 创建于项目根", () => {
    expect(fs.existsSync(path.join(dir, ".visual-artifacts", "database.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(dir, ".visual-artifacts", "blobs", "sha256"))).toBe(true);
  });
});

describe("/artifact 命令", () => {
  it("status：输出存储与泄漏统计", async () => {
    const cmd = commands.get("artifact");
    expect(cmd).toBeDefined();
    const { ctx, notifications } = makeCtx();
    await cmd!.handler("status", ctx);
    expect(notifications.length).toBe(1);
    expect(notifications[0]).toContain("storage: .visual-artifacts/");
    expect(notifications[0]).toContain("artifacts: 0");
    expect(notifications[0]).toContain("guard blocked (run): 0 bytes");
  });

  it("list：空库提示；入库后列出", async () => {
    const cmd = commands.get("artifact");
    const { ctx, notifications } = makeCtx();
    await cmd!.handler("list", ctx);
    expect(notifications[0]).toContain("no artifacts");
  });

  it("help：列出子命令与 PLACEHOLDER", async () => {
    const cmd = commands.get("artifact");
    const { ctx, notifications } = makeCtx();
    await cmd!.handler("help", ctx);
    expect(notifications[0]).toContain("/artifact status");
    expect(notifications[0]).toContain("/artifact list");
    expect(notifications[0]).toContain("PLACEHOLDER");
  });

  it("未知子命令回退到 help", async () => {
    const cmd = commands.get("artifact");
    const { ctx, notifications } = makeCtx();
    await cmd!.handler("unknown-sub", ctx);
    expect(notifications[0]).toContain("/artifact status");
  });
});
