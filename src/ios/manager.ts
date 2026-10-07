import { isValidArtifactId } from "../core/artifact";
import type {
  CameraManArtifact,
  CameraManArtifactActivation,
  CameraManArtifactIngestInput,
  CameraManArtifactStorePort,
} from "./types";

function requireNonEmpty(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} is required`);
  return normalized;
}

export function formatCameraManArtifactReference(
  artifact: CameraManArtifact,
): string {
  const lines = [
    "[Artifact Reference]",
    `id: ${artifact.id}`,
    `source: ${artifact.source}`,
    `mime: ${artifact.mimeType}`,
    `size: ${artifact.byteSize}`,
  ];
  if (artifact.summary) lines.push(`summary: ${artifact.summary}`);
  return lines.join("\n");
}

/**
 * Thin CameraMan adapter for Pi Artifact Manager semantics.
 *
 * It intentionally manages only durable photos explicitly promoted by the
 * app (captures, retouches, and user-selected images). Live preview frames do
 * not cross this API and therefore cannot enter artifact storage.
 */
export class CameraManArtifactManager {
  constructor(private readonly store: CameraManArtifactStorePort) {}

  async ingestPhoto(
    input: CameraManArtifactIngestInput,
  ): Promise<CameraManArtifact> {
    const normalized: CameraManArtifactIngestInput = {
      ...input,
      sessionId: requireNonEmpty(input.sessionId, "sessionId"),
      uri: requireNonEmpty(input.uri, "uri"),
      mimeType: requireNonEmpty(input.mimeType, "mimeType"),
      summary: input.summary?.trim() || null,
    };
    const artifact = await this.store.ingest(normalized);
    if (!isValidArtifactId(artifact.id)) {
      throw new Error(`Native artifact store returned an invalid id: ${artifact.id}`);
    }
    await this.store.addToSession(normalized.sessionId, artifact.id);
    return artifact;
  }

  async list(sessionId: string): Promise<CameraManArtifact[]> {
    return this.store.list(requireNonEmpty(sessionId, "sessionId"));
  }

  async activate(
    sessionId: string,
    artifactId: string,
  ): Promise<CameraManArtifactActivation> {
    const id = artifactId.trim();
    if (!isValidArtifactId(id)) throw new Error(`Invalid artifact id: ${id}`);
    const artifact = await this.store.get(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    if (artifact.status === "archived") {
      throw new Error(`Artifact is archived: ${id}`);
    }
    const active =
      artifact.status === "active"
        ? artifact
        : await this.store.setStatus(id, "active");
    await this.store.addToSession(requireNonEmpty(sessionId, "sessionId"), id);
    return {
      artifact: active,
      referenceText: formatCameraManArtifactReference(active),
    };
  }

  async markConsumed(artifactId: string): Promise<CameraManArtifact> {
    const id = artifactId.trim();
    if (!isValidArtifactId(id)) throw new Error(`Invalid artifact id: ${id}`);
    const artifact = await this.store.get(id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    if (artifact.status === "archived" || artifact.status === "consumed") {
      return artifact;
    }
    return this.store.setStatus(id, "consumed");
  }
}
