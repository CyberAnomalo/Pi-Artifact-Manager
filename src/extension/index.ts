/**
 * pi-artifact-manager — Pi extension 主入口。
 *
 * 组装：
 *   core/ArtifactStore  — SQLite + blob 存储（确定性 ingest）
 *   extension/hooks     — input / context / before_provider_request / session hooks
 *   tools               — artifact_list / artifact_get / artifact_stats
 *   commands            — /artifact（status / list / help）
 *
 * 第一阶段目标：解决 Coding Harness 多模态上下文污染问题，
 * 同时留下未来扩展 Artifact 系统的接口（见 core/placeholders.ts）。
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ArtifactStore, STORAGE_DIR_NAME } from "../core/store.js";
import { createState, registerHooks, allowHash } from "./hooks.js";
import type { ExtensionState } from "./hooks.js";
import { createListTool } from "../tools/list.js";
import { createGetTool } from "../tools/get.js";
import { createStatsTool } from "../tools/stats.js";
import { formatBytes } from "./context.js";

function registerArtifactCommand(pi: ExtensionAPI, state: ExtensionState): void {
  const SUBCOMMANDS = ["status", "list", "help"];

  pi.registerCommand("artifact", {
    description: "Visual artifact management (pi-artifact-manager)",
    getArgumentCompletions(prefix: string) {
      return SUBCOMMANDS.filter((s) => s.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      const sub = args.trim().split(/\s+/)[0] || "status";
      const { store } = state;

      if (sub === "list") {
        const artifacts = store.list(false);
        if (artifacts.length === 0) {
          ctx.ui.notify("pi-artifact-manager: no artifacts stored yet");
          return;
        }
        const lines = artifacts.map(
          (a, i) => `Artifact #${i + 1}  ${a.id}  ${formatBytes(a.byteSize)}  ${a.status}`,
        );
        ctx.ui.notify(`pi-artifact-manager:\n${lines.join("\n")}`);
        return;
      }

      if (sub === "status") {
        const stats = store.stats();
        const text = [
          `storage: ${STORAGE_DIR_NAME}/`,
          `artifacts: ${stats.artifactCount}  blobs: ${stats.blobCount}`,
          `storage bytes: ${formatBytes(stats.storageBytes)}`,
          `context removed (run): ${state.counters.contextRemovedMediaBytes} bytes`,
          `guard blocked (run): ${state.counters.guardBlockedMediaBytes} bytes`,
        ].join("\n");
        ctx.ui.notify(`pi-artifact-manager:\n${text}`);
        return;
      }

      // help（含 PLACEHOLDER 未来命令）
      ctx.ui.notify(
        [
          "/artifact status — 存储与泄漏统计",
          "/artifact list   — 列出 artifacts",
          "PLACEHOLDER: /artifact archive, /artifact export, /artifact branch",
        ].join("\n"),
      );
    },
  });
}

export default function artifactManagerExtension(pi: ExtensionAPI): void {
  // .visual-artifacts/ 位于项目根（pi 启动 cwd）
  const store = new ArtifactStore(process.cwd());
  const state = createState(store);

  // 事件钩子（input / context / before_provider_request / session_*）
  registerHooks(pi, state);

  // Agent 工具（MVP 只做三个）
  pi.registerTool(createListTool(store));
  pi.registerTool(
    createGetTool(store, (blobHash, _artifactId) => allowHash(state, blobHash)),
  );
  pi.registerTool(createStatsTool(store, state.counters));

  // slash 命令
  registerArtifactCommand(pi, state);
}

// PLACEHOLDER 未来工具（设计文档 §10，明确不实现）：
//   artifact_compare / artifact_branch / artifact_tag / artifact_merge / artifact_export
