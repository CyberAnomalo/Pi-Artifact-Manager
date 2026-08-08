/**
 * artifact_get — 按 id 重新加载图片到当前请求。
 *
 * 设计流程：SQLite → Blob → temporary image → current request
 *
 * 副作用：
 *   - 状态迁移 consumed → active（显式重载允许再次进入当前轮）
 *   - 通过 onReload 回调把 blob hash 加入当前轮 allowedHashes（guard 放行）
 */

import { Type } from "typebox";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ArtifactStore } from "../core/store.js";
import { isValidArtifactId } from "../core/artifact.js";

interface GetDetails {
  ok: boolean;
  artifactId: string | null;
  blobHash: string | null;
  byteSize: number;
}

export function createGetTool(
  store: ArtifactStore,
  onReload: (blobHash: string, artifactId: string) => void,
) {
  return {
    name: "artifact_get",
    label: "Artifact Get",
    description:
      "Reload an archived artifact image by id (e.g. artifact_a83fd91) back into the current request. " +
      "Use this when you need the original image behind an [Artifact Reference] stub.",
    promptSnippet: "Reload an archived image artifact by its id into the current turn",
    parameters: Type.Object({
      id: Type.String({ description: "Artifact id, e.g. artifact_a83fd91" }),
    }),
    async execute(_toolCallId: string, params: { id: string }): Promise<AgentToolResult<GetDetails>> {
      const id = String(params.id ?? "").trim();
      if (!isValidArtifactId(id)) {
        return {
          content: [{ type: "text" as const, text: `Invalid artifact id: ${id}` }],
          details: { ok: false, artifactId: null, blobHash: null, byteSize: 0 },
        };
      }

      const artifact = store.get(id);
      if (!artifact) {
        return {
          content: [{ type: "text" as const, text: `Artifact not found: ${id}` }],
          details: { ok: false, artifactId: id, blobHash: null, byteSize: 0 },
        };
      }

      // 读 blob → base64 → 图片块进入当前请求
      const data = store.readBlob(artifact);
      const base64 = data.toString("base64");

      // 生命周期：consumed/created → active（幂等处理 archived 报错）
      if (artifact.status === "consumed" || artifact.status === "created") {
        store.transition(id, "active");
      }
      onReload(artifact.blobHash, artifact.id);

      return {
        content: [
          {
            type: "image" as const,
            data: base64,
            mimeType: artifact.mimeType ?? "image/png",
          },
        ],
        details: { ok: true, artifactId: artifact.id, blobHash: artifact.blobHash, byteSize: artifact.byteSize },
      };
    },
  };
}
