import { describe, expect, it } from "bun:test";
import {
  CameraManArtifactManager,
  createCameraManArtifactTools,
  type CameraManArtifact,
  type CameraManArtifactStorePort,
} from "../../src/ios/index.js";

function createStore(): CameraManArtifactStorePort {
  const artifacts = new Map<string, CameraManArtifact>();
  const sessions = new Map<string, Set<string>>();
  return {
    async ingest(input) {
      const artifact: CameraManArtifact = {
        id: "artifact_a83fd91",
        blobHash: "a83fd91".padEnd(64, "0"),
        uri: input.uri,
        mimeType: input.mimeType,
        byteSize: 123,
        source: input.source,
        summary: input.summary ?? null,
        status: "active",
        createdAt: input.createdAt ?? 1,
      };
      artifacts.set(artifact.id, artifact);
      return artifact;
    },
    async get(id) {
      return artifacts.get(id);
    },
    async list(sessionId) {
      const ids = sessions.get(sessionId) ?? new Set();
      return [...ids].flatMap((id) => artifacts.get(id) ?? []);
    },
    async setStatus(id, status) {
      const current = artifacts.get(id);
      if (!current) throw new Error("missing artifact");
      const next = { ...current, status };
      artifacts.set(id, next);
      return next;
    },
    async addToSession(sessionId, artifactId) {
      const ids = sessions.get(sessionId) ?? new Set<string>();
      ids.add(artifactId);
      sessions.set(sessionId, ids);
    },
  };
}

describe("CameraMan iOS adapter", () => {
  it("ingests only explicitly promoted photos and activates them by id", async () => {
    const manager = new CameraManArtifactManager(createStore());
    const artifact = await manager.ingestPhoto({
      sessionId: "session-1",
      uri: "file:///capture.jpg",
      mimeType: "image/jpeg",
      source: "agent-capture",
      summary: "first composition attempt",
    });
    await manager.markConsumed(artifact.id);

    const activated: string[] = [];
    const tools = createCameraManArtifactTools({
      manager,
      getSessionId: () => "session-1",
      onActivate: ({ artifact: value }) => activated.push(value.uri),
    });
    const get = tools.find((tool) => tool.name === "artifact.get");
    if (!get) throw new Error("missing artifact.get");
    const result = await get.execute({ id: artifact.id } as never);

    expect(result.ok).toBe(true);
    expect(activated).toEqual(["file:///capture.jpg"]);
    expect(JSON.stringify(result)).not.toContain("file:///capture.jpg");
  });

  it("never defines a preview-frame ingest API", () => {
    const methods = Object.getOwnPropertyNames(CameraManArtifactManager.prototype);
    expect(methods).toContain("ingestPhoto");
    expect(methods).not.toContain("ingestPreviewFrame");
  });
});
