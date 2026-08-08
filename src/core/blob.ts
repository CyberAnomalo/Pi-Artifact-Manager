/**
 * BlobStore — 内容寻址的文件系统存储。
 *
 * 保证：同一个图片 100 次上传 → 1 份 blob（sha256 去重）。
 *
 * 目录布局：
 *   .visual-artifacts/
 *   ├── blobs/sha256/<hash 前 2 位>/<hash>.<ext>
 *   ├── thumbnails/   (PLACEHOLDER: 缩略图，MVP 不生成)
 *   ├── temp/         (artifact_get 恢复时的临时文件)
 *   └── exports/      (PLACEHOLDER: 导出目录)
 *
 * Core 层保持独立：只依赖 node:fs / node:crypto，不依赖 Pi。
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

export function sha256Hex(data: Uint8Array | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Base64(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

export class BlobStore {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** 确保目录骨架存在（含 PLACEHOLDER 目录）。 */
  ensureLayout(): void {
    for (const dir of [
      path.join(this.root, "blobs", "sha256"),
      path.join(this.root, "thumbnails"), // PLACEHOLDER
      path.join(this.root, "temp"),
      path.join(this.root, "exports"), // PLACEHOLDER
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** blob 绝对路径：blobs/sha256/<前2位>/<hash>.<ext> */
  blobPath(hash: string, mimeType?: string | null): string {
    const ext = MIME_EXT[mimeType ?? ""] ?? "bin";
    return path.join(this.root, "blobs", "sha256", hash.slice(0, 2), `${hash}.${ext}`);
  }

  /** 相对 root 的路径（入库用）。 */
  relativeBlobPath(hash: string, mimeType?: string | null): string {
    return path.relative(this.root, this.blobPath(hash, mimeType)).split(path.sep).join("/");
  }

  exists(hash: string, mimeType?: string | null): boolean {
    return fs.existsSync(this.blobPath(hash, mimeType));
  }

  /**
   * 写入 blob。若已存在（同 hash）直接复用，返回 { path, deduplicated }。
   */
  write(data: Buffer, hash: string, mimeType?: string | null): { path: string; deduplicated: boolean } {
    const target = this.blobPath(hash, mimeType);
    if (fs.existsSync(target)) {
      return { path: path.relative(this.root, target).split(path.sep).join("/"), deduplicated: true };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 先写临时文件再 rename，避免半写状态
    const tmp = path.join(this.root, "temp", `${hash}.tmp`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, target);
    return { path: path.relative(this.root, target).split(path.sep).join("/"), deduplicated: false };
  }

  read(hash: string, mimeType?: string | null): Buffer {
    return fs.readFileSync(this.blobPath(hash, mimeType));
  }

  size(hash: string, mimeType?: string | null): number {
    return fs.statSync(this.blobPath(hash, mimeType)).size;
  }

  /** 所有 blob 的总字节数（artifact_stats 用）。 */
  totalBytes(): number {
    const base = path.join(this.root, "blobs", "sha256");
    if (!fs.existsSync(base)) return 0;
    let total = 0;
    for (const shard of fs.readdirSync(base)) {
      const shardDir = path.join(base, shard);
      if (!fs.statSync(shardDir).isDirectory()) continue;
      for (const file of fs.readdirSync(shardDir)) {
        total += fs.statSync(path.join(shardDir, file)).size;
      }
    }
    return total;
  }
}
