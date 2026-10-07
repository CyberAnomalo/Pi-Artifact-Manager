import type { ArtifactStatus } from "../core/lifecycle.js";

export type CameraManArtifactSource =
  | "agent-capture"
  | "photo-retouch"
  | "user-input";

export interface CameraManArtifact {
  id: string;
  blobHash: string;
  uri: string;
  mimeType: string;
  byteSize: number;
  source: CameraManArtifactSource;
  summary: string | null;
  status: ArtifactStatus;
  createdAt: number;
}

export interface CameraManArtifactIngestInput {
  sessionId: string;
  uri: string;
  mimeType: string;
  source: CameraManArtifactSource;
  summary?: string | null;
  createdAt?: number;
}

/**
 * Native storage boundary for iOS. Binary image data stays in Swift; the JS
 * agent receives only identifiers, metadata, and sandbox file URIs.
 */
export interface CameraManArtifactStorePort {
  ingest(input: CameraManArtifactIngestInput): Promise<CameraManArtifact>;
  get(id: string): Promise<CameraManArtifact | undefined>;
  list(sessionId: string): Promise<CameraManArtifact[]>;
  setStatus(id: string, status: ArtifactStatus): Promise<CameraManArtifact>;
  addToSession(sessionId: string, artifactId: string): Promise<void>;
}

export interface CameraManArtifactActivation {
  artifact: CameraManArtifact;
  referenceText: string;
}
