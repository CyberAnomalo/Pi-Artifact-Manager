/**
 * pi-artifact-manager — Pi coding-agent extension.
 *
 * 第一阶段：解决 Coding Harness 多模态上下文污染问题。
 *   - 确定性逻辑优先，不依赖 LLM 分类
 *   - 图片生命周期管理优先于语义管理
 *   - 所有未实现功能保留接口和 placeholder（src/core/placeholders.ts）
 *
 * 入口实现在 src/extension/index.ts。
 */

export { default } from "./src/extension/index.js";
