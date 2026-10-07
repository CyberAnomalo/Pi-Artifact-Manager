import type { CameraManArtifactManager } from "./manager";
import type { CameraManArtifactActivation } from "./types";

export interface CameraManArtifactToolResult {
  ok: boolean;
  data?: unknown;
  message?: string;
}

export interface CameraManArtifactTool<Input> {
  name: "artifact.list" | "artifact.get";
  description: string;
  inputSchema: Record<string, unknown>;
  execute(input: Input): Promise<CameraManArtifactToolResult>;
}

export function createCameraManArtifactTools(options: {
  manager: CameraManArtifactManager;
  getSessionId(): string;
  onActivate?(activation: CameraManArtifactActivation): void | Promise<void>;
}): CameraManArtifactTool<never>[] {
  const list: CameraManArtifactTool<{ includeConsumed?: boolean }> = {
    name: "artifact.list",
    description:
      "List durable photos created during this camera-agent session. Live preview frames are never included.",
    inputSchema: {
      type: "object",
      properties: { includeConsumed: { type: "boolean" } },
      additionalProperties: false,
    },
    async execute(input) {
      const artifacts = await options.manager.list(options.getSessionId());
      return {
        ok: true,
        data: artifacts
          .filter((artifact) => input.includeConsumed === true || artifact.status === "active")
          .map(({ id, mimeType, byteSize, source, summary, status, createdAt }) => ({
            id,
            mimeType,
            byteSize,
            source,
            summary,
            status,
            createdAt,
          })),
      };
    },
  };

  const get: CameraManArtifactTool<{ id: string }> = {
    name: "artifact.get",
    description:
      "Activate one previously captured photo by artifact id so camera tools can score or retouch it.",
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", pattern: "^artifact_[0-9a-f]{7,64}$" } },
      additionalProperties: false,
    },
    async execute(input) {
      try {
        const activation = await options.manager.activate(
          options.getSessionId(),
          input.id,
        );
        await options.onActivate?.(activation);
        return {
          ok: true,
          data: {
            id: activation.artifact.id,
            mimeType: activation.artifact.mimeType,
            byteSize: activation.artifact.byteSize,
            source: activation.artifact.source,
            summary: activation.artifact.summary,
            reference: activation.referenceText,
          },
        };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };

  return [list, get] as CameraManArtifactTool<never>[];
}
