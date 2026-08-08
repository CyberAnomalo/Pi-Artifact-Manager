/**
 * 测试公共 helpers — 假图片生成 / 上下文媒体统计 / 临时 store fixture。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactStore } from "../src/core/store.js";
import { base64ByteSize, type AgentMessageLike } from "../src/extension/context.js";

export function makeImage(base64: string, mimeType = "image/png") {
  return { type: "image" as const, data: base64, mimeType };
}

export function makeText(text: string) {
  return { type: "text" as const, text };
}

/**
 * 生成可区分的假图片字节。
 *
 * 确定性（LCG 填充）：
 *   - 同 index 多次调用 → 相同字节（hash 可复现，符合项目确定性优先原则）
 *   - 不同 index → 不同字节（不同 hash）
 */
export function fakeImageBytes(index: number, sizeBytes = 24 * 1024): Buffer {
  const buf = Buffer.alloc(sizeBytes);
  let s = ((index + 1) >>> 0) || 1;
  for (let i = 0; i < sizeBytes; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    buf[i] = s & 0xff;
  }
  return buf;
}

/** 统计消息数组中的原始媒体字节（泄漏度量）。 */
export function countMediaBytesInContext(messages: AgentMessageLike[]): number {
  let bytes = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (typeof block === "object" && block !== null && (block as { type?: string }).type === "image") {
        bytes += base64ByteSize(String((block as { data: string }).data));
      }
    }
  }
  return bytes;
}

/** 统计 payload（任意 JSON）中的媒体字节 —— provider 出口视角。 */
export function countMediaBytesInPayload(payload: unknown): number {
  let bytes = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node === "object" && node !== null) {
      const obj = node as Record<string, unknown>;
      if ((obj.type === "image" || obj.type === "input_image") && typeof obj.data === "string") {
        bytes += base64ByteSize(obj.data);
        return;
      }
      if (obj.type === "image_url") {
        const url = (obj.image_url as { url?: unknown } | undefined)?.url;
        if (typeof url === "string") {
          const m = /^data:image\/[^;]+;base64,(.+)$/s.exec(url);
          if (m) bytes += base64ByteSize(m[1]);
        }
        return;
      }
      for (const value of Object.values(obj)) walk(value);
    }
  };
  walk(payload);
  return bytes;
}

/** 临时目录 + ArtifactStore fixture。 */
export function createTempStore(): { dir: string; store: ArtifactStore; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-test-"));
  const store = new ArtifactStore(dir);
  const cleanup = () => {
    try {
      store.close();
    } catch {}
    try {
      // Windows 上 SQLite WAL 文件可能短暂被锁，容忍清理失败
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {}
  };
  return { dir, store, cleanup };
}

/** RAR = 累计发送媒体字节 / 用户实际输入唯一媒体字节。 */
export function replayAmplificationRatio(sentMediaBytes: number, uniqueInputMediaBytes: number): number {
  if (uniqueInputMediaBytes === 0) return sentMediaBytes === 0 ? 1 : Number.POSITIVE_INFINITY;
  return sentMediaBytes / uniqueInputMediaBytes;
}

// ---- 真实 PNG 生成（L2 用：pi CLI 按 magic bytes 识别图片附件）----

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * 生成合法 PNG（灰度，随机像素 → 不可压缩，体积 ≈ width×height）。
 * pi CLI 的 @file 附件按 magic bytes 识别，L2 必须用真实图片。
 */
export function makeRealPng(width: number, height: number, seed = 1): Buffer {
  const { deflateSync } = require("node:zlib") as typeof import("node:zlib");

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 确定性伪随机填充（seed 不同 → 不同图片）
  const raw = Buffer.alloc((width + 1) * height);
  let s = seed >>> 0 || 1;
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      raw[y * (width + 1) + 1 + x] = s & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- 文字渲染 PNG（L3 用：验证码测试图，防 summary 作弊）----

/** 5×7 位图字体（每字符 7 行 × 5 位，MSB 在左）。覆盖 A-Z / 0-9 / '-'。 */
const FONT_5X7: Record<string, number[]> = {
  "0": [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  "1": [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  "2": [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  "3": [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  "4": [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  "5": [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  "6": [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  "7": [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  "8": [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  "9": [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  "-": [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0e],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x15, 0x0a],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
};

/**
 * 生成带文字的合法灰度 PNG（白底黑字，确定性）。
 * L3 防作弊验证码测试图：文字只存在于像素中，模型必须真的看图才能读出。
 *
 * scale 默认 24：字形 120×168px，远大于 Qwen 视觉 32×32 patch，
 * 即使 provider 端下采样仍可 OCR（scale=12 实测被误读）。
 */
export function makeTextPng(lines: string[], scale = 24): Buffer {
  const { deflateSync } = require("node:zlib") as typeof import("node:zlib");

  const text = lines.map((l) => l.toUpperCase());
  const maxChars = Math.max(...text.map((l) => l.length));
  const margin = 3 * scale;
  const width = margin * 2 + maxChars * 6 * scale;
  const height = margin * 2 + text.length * 9 * scale;

  // 白底
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y++) raw[y * (width + 1)] = 0; // filter: none

  // 逐行逐字符渲染（黑字）
  text.forEach((line, row) => {
    [...line].forEach((ch, col) => {
      const glyph = FONT_5X7[ch];
      if (!glyph) return;
      for (let gy = 0; gy < 7; gy++) {
        for (let gx = 0; gx < 5; gx++) {
          if (!(glyph[gy] & (0x10 >> gx))) continue;
          const baseX = margin + col * 6 * scale + gx * scale;
          const baseY = margin + row * 9 * scale + gy * scale;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              raw[(baseY + sy) * (width + 1) + 1 + baseX + sx] = 0;
            }
          }
        }
      }
    });
  });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // grayscale

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 生成随机验证码（排除易混淆字符 0/O/1/I/L）。格式 XXXX-XXXX。 */
export function randomVerificationCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const pick = (n: number) =>
    Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  return `${pick(4)}-${pick(4)}`;
}
