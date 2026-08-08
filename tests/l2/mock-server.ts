/**
 * L2 Mock Provider Server — 本地 HTTP 出口记录器。
 *
 * 实现最小 OpenAI Completions 流式协议（SSE），把每个真实 HTTP 请求体
 * 原样落盘 —— 这是「provider 实际收到什么」的最终证据（比 L1 更真实：
 * 经过真实 CLI 进程、真实 HTTP 序列化）。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

export interface MockServerHandle {
  port: number;
  baseUrl: string;
  requestsDir: string;
  /** 按时间序读取记录的请求体 */
  readRequests(): { seq: number; body: Record<string, unknown> }[];
  close(): Promise<void>;
}

export async function startMockProviderServer(workDir: string): Promise<MockServerHandle> {
  const requestsDir = path.join(workDir, "mock-requests");
  fs.mkdirSync(requestsDir, { recursive: true });
  let seq = 0;

  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.includes("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {}

      const currentSeq = ++seq;
      fs.writeFileSync(path.join(requestsDir, `${String(currentSeq).padStart(3, "0")}.json`), raw);

      // 最小 SSE 流式响应（OpenAI chat.completion.chunk）
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const base = {
        id: `chatcmpl-mock-${currentSeq}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: String(body.model ?? "mock-vision"),
      };
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: { role: "assistant", content: "mock ok" }, finish_reason: null }],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requestsDir,
    readRequests() {
      if (!fs.existsSync(requestsDir)) return [];
      return fs
        .readdirSync(requestsDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => ({
          seq: Number.parseInt(f, 10),
          body: JSON.parse(fs.readFileSync(path.join(requestsDir, f), "utf8")),
        }));
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
