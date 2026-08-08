/**
 * L2 Provider 注册扩展 — 由真实 pi CLI 进程通过 `-e` 加载。
 *
 * 作用：把 mock-l2 provider 指向本地 mock HTTP server
 * （端口经环境变量 L2_MOCK_PORT 传入）。
 *
 * 注意：本文件运行在 pi CLI 子进程内（jiti 加载），
 * 只做 provider 注册，不含任何测试断言逻辑。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function mockProviderExtension(pi: ExtensionAPI): void {
  const port = process.env.L2_MOCK_PORT;
  if (!port) {
    throw new Error("L2_MOCK_PORT is required for the L2 mock provider extension");
  }

  pi.registerProvider("mock-l2", {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    apiKey: "mock-key",
    api: "openai-completions",
    models: [
      {
        id: "mock-vision",
        name: "Mock Vision",
        api: "openai-completions",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  });
}
