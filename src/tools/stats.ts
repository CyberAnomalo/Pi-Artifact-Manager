/**
 * artifact_stats — 统计：artifact 数量 / 存储字节 / 历史媒体字节。
 *
 * MVP 完成标准 Requirement 1 的可观测出口：
 *   上传 100 张图片后，historical_media_bytes（上下文中的）= 0。
 */

import { Type } from "typebox";
import type { ArtifactStore } from "../core/store.js";
import { formatBytes } from "../extension/context.js";

export interface RuntimeCounters {
  /** context hook 从上下文中剥离的历史媒体字节（本次运行累计） */
  contextRemovedMediaBytes: number;
  /** guard 在 payload 层拦截的历史媒体字节（本次运行累计） */
  guardBlockedMediaBytes: number;
}

export function createStatsTool(store: ArtifactStore, counters: RuntimeCounters) {
  return {
    name: "artifact_stats",
    label: "Artifact Stats",
    description:
      "Show artifact storage statistics: artifact count, on-disk storage bytes, " +
      "and historical media bytes blocked from provider requests.",
    promptSnippet: "Show artifact storage statistics and media-leak counters",
    parameters: Type.Object({}),
    async execute() {
      const stats = store.stats();
      const inContextLeak = Math.max(0, counters.contextRemovedMediaBytes - counters.guardBlockedMediaBytes);

      const text = [
        "Artifacts:",
        `  ${stats.artifactCount}`,
        "",
        "Storage:",
        `  ${formatBytes(stats.storageBytes)} (${stats.blobCount} deduplicated blobs)`,
        "",
        "Historical media:",
        `  in-context bytes removed this run: ${counters.contextRemovedMediaBytes}`,
        `  payload-guard blocked this run: ${counters.guardBlockedMediaBytes}`,
        `  current context leak estimate: ${inContextLeak} byte`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text }],
        details: { ...stats, counters: { ...counters } },
      };
    },
  };
}
