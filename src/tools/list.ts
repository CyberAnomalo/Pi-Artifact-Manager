/**
 * artifact_list — 查看所有 artifact（id / size / summary / status）。
 */

import { Type } from "typebox";
import type { ArtifactStore } from "../core/store.js";
import { formatBytes } from "../extension/context.js";

export function createListTool(store: ArtifactStore) {
  return {
    name: "artifact_list",
    label: "Artifact List",
    description:
      "List all managed visual artifacts (id, size, summary, status). " +
      "Historical images in context are replaced by artifact references; use this to see what is available.",
    promptSnippet: "List archived visual artifacts with their ids, sizes and statuses",
    parameters: Type.Object({
      include_archived: Type.Optional(
        Type.Boolean({ description: "Include archived artifacts (default false)" }),
      ),
    }),
    async execute(_toolCallId: string, params: { include_archived?: boolean }) {
      const artifacts = store.list(params.include_archived === true);
      if (artifacts.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No artifacts stored yet." }],
          details: { count: 0 },
        };
      }

      const lines = artifacts.map((a, index) => {
        const summary = a.summary ? ` | summary: ${a.summary}` : "";
        return `Artifact #${index + 1}  ${a.id}  size: ${formatBytes(a.byteSize)}  status: ${a.status}${summary}`;
      });

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { count: artifacts.length },
      };
    },
  };
}
