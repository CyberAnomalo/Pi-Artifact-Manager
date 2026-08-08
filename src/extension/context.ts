/**
 * Context Manager — pi-artifact-manager 核心模块。
 *
 * 作用：修改发送给模型的上下文，保证历史图片不以原始字节形式进入 LLM。
 *
 *   输入 AgentMessage[] → 输出 AgentMessage[]
 *
 * 确定性规则（无 LLM 参与）：
 *   1. 定位最后一个 user message 的索引（= 当前轮起点）。
 *   2. 索引 >= 该位置的消息属于当前轮：图片允许（image allowed once）。
 *   3. 更早消息中的图片块 = 历史媒体：
 *        - lazy ingest（未入库则现场入库，sha256 去重）
 *        - 替换为 [Artifact Reference] 文本块（id + summary）
 *        - artifact 状态迁移 → consumed
 *
 * 使用结构化最小类型（与 pi-ai 的 AgentMessage/ImageContent 结构兼容），
 * 保证 core/测试可在未安装 pi-ai 时运行。
 */

import type { ArtifactStore } from "../core/store.js";
import { sha256Base64 } from "../core/blob.js";

// ---- 与 pi-ai 结构兼容的最小类型 ----

export interface ImageBlock {
  type: "image";
  data: string; // base64
  mimeType: string;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export type ContentBlock = TextBlock | ImageBlock | { type: string; [key: string]: unknown };

export interface AgentMessageLike {
  role: string;
  content: string | ContentBlock[];
  [key: string]: unknown;
}

export interface TransformResult {
  messages: AgentMessageLike[];
  /** 被替换的历史图片块数量 */
  replacedCount: number;
  /** 被剥离的历史媒体原始字节（base64 解码后） */
  removedMediaBytes: number;
  /** 本轮涉及的 artifact id */
  artifactIds: string[];
  /**
   * 当前轮媒体块的 blob hash（含用户输入与 toolResult 图片）。
   * hooks 层据此授权 guard 放行（image allowed once）：guard 只认
   * allowedHashes，用户输入路径由 input 钩子授权，toolResult 路径
   * 无其他授权入口，必须由此处补齐。
   */
  currentTurnMediaHashes: string[];
}

export function isImageBlock(block: unknown): block is ImageBlock {
  return (
    typeof block === "object" &&
    block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string"
  );
}

/** 估算 base64 图片解码后的字节数（确定性：length * 3/4）。 */
export function base64ByteSize(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/** 生成替换用的 artifact 引用文本块。 */
export function makeArtifactRefText(artifactId: string, summary: string | null, byteSize: number): string {
  const lines = ["[Artifact Reference]", `id: ${artifactId}`];
  if (summary) lines.push(`summary: ${summary}`);
  lines.push(`size: ${formatBytes(byteSize)}`);
  lines.push("(original image archived; use artifact_get to reload if needed)");
  return lines.join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * 转换上下文：剥离历史图片，替换为 artifact 引用。
 *
 * @param messages  当前上下文消息数组（不会被原地修改）
 * @param store     ArtifactStore 实例（lazy ingest + 状态迁移）
 */
export function transformContext(messages: AgentMessageLike[], store: ArtifactStore): TransformResult {
  const result: TransformResult = {
    messages,
    replacedCount: 0,
    removedMediaBytes: 0,
    artifactIds: [],
    currentTurnMediaHashes: [],
  };

  // 1. 定位最后一个 user message（当前轮起点）
  let currentTurnStart = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      currentTurnStart = i;
      break;
    }
  }
  // 没有 user message（极端情况）：一切图片视为当前轮，保守不替换
  if (currentTurnStart < 0) return result;

  const output: AgentMessageLike[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];

    // 当前轮及之后：原样保留（image allowed once），但收集媒体 hash 供 guard 授权
    if (i >= currentTurnStart || !Array.isArray(message.content)) {
      if (i >= currentTurnStart && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (isImageBlock(block)) result.currentTurnMediaHashes.push(sha256Base64(block.data));
        }
      }
      output.push(message);
      continue;
    }

    // 历史消息：逐块检查
    let changed = false;
    const newContent: ContentBlock[] = [];
    for (const block of message.content) {
      if (!isImageBlock(block)) {
        newContent.push(block);
        continue;
      }

      // 历史图片 → lazy ingest（hash 已知则直接复用 artifact）
      const hash = sha256Base64(block.data);
      const byteSize = base64ByteSize(block.data);
      let artifact = store.findByHash(hash);
      if (!artifact) {
        const ingested = store.ingest({
          data: Buffer.from(block.data, "base64"),
          mimeType: block.mimeType ?? null,
          source: message.role === "toolResult" ? "tool-result" : "user-input",
        });
        artifact = store.get(ingested.artifactId)!;
      }
      store.markConsumed(artifact.id);

      newContent.push({
        type: "text",
        text: makeArtifactRefText(artifact.id, artifact.summary, byteSize),
      } satisfies TextBlock);

      result.replacedCount += 1;
      result.removedMediaBytes += byteSize;
      result.artifactIds.push(artifact.id);
      changed = true;
    }

    if (changed) {
      output.push({ ...message, content: newContent });
    } else {
      output.push(message);
    }
  }

  result.messages = output;
  return result;
}
