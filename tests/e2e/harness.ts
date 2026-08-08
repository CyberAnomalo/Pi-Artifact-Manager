/**
 * L1 E2E Harness — 真实 pi 运行时 + faux provider payload 捕获。
 *
 * 这不是 mock：扩展通过 pi 真实的 resource loader 加载，
 * hooks 走真实事件链（input → context → before_provider_request），
 * faux provider 收到的 Context 就是「provider 实际收到的请求」——
 * 这是证明媒体字节是否到达模型端的硬证据。
 *
 * Step 1（实验设计）：先证明能抓到 provider payload，再谈断言。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, createFauxCore } from "@earendil-works/pi-ai";
import {
  registerApiProvider,
  unregisterApiProviders,
  fauxAssistantMessage,
  type FauxResponseStep,
} from "@earendil-works/pi-ai/compat";
import artifactManagerExtension from "../../index.ts";
import { countMediaBytesInPayload } from "../helpers.js";

export interface CapturedRequest {
  index: number;
  /** provider 实际收到的请求上下文（guard 之后的最终形态） */
  context: unknown;
  /** 该请求中的媒体字节（解码后估算） */
  mediaBytes: number;
  /** 该请求的 JSON 序列化体积 */
  totalBytes: number;
}

export interface E2EHarnessOptions {
  /** 是否加载 pi-artifact-manager（false = 无插件基线组） */
  withPlugin?: boolean;
  /** 默认 faux 响应（可后续 setResponses 覆盖） */
  responses?: FauxResponseStep[];
  /** 额外的内联扩展（如注册返回图片的自定义工具，模拟 E7 多入口） */
  extraFactories?: Array<(pi: ExtensionAPI) => void>;
  /** 自定义 SessionManager（E3 resume：传入 SessionManager.open(file)） */
  sessionManager?: SessionManager;
  /** true = 文件会话（默认 inMemory） */
  fileSession?: boolean;
  /** 复用指定 workDir（E3 resume：同一项目目录两次启动；此时 cleanup 不删目录） */
  workDir?: string;
  /** 覆盖 settings（如 compaction.keepRecentTokens，便于小会话触发 compact） */
  settings?: Record<string, unknown>;
}

export interface E2EHarness {
  workDir: string;
  session: {
    prompt(text: string, options?: { images?: { type: "image"; data: string; mimeType: string }[] }): Promise<void>;
    dispose?(): void;
  };
  sessionManager: SessionManager;
  /** provider 出口捕获记录（时间序） */
  captured: CapturedRequest[];
  setResponses(steps: FauxResponseStep[]): void;
  appendResponses(steps: FauxResponseStep[]): void;
  cleanup(): Promise<void>;
}

export async function createE2EHarness(options: E2EHarnessOptions = {}): Promise<E2EHarness> {
  const withPlugin = options.withPlugin ?? true;

  const externalWorkDir = options.workDir;
  const workDir = externalWorkDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "pi-artifact-e2e-"));
  fs.mkdirSync(workDir, { recursive: true });
  const agentDir = path.join(workDir, ".pi-agent");
  fs.mkdirSync(agentDir, { recursive: true });
  // 插件存储目录 .visual-artifacts/ 跟随 process.cwd()
  const prevCwd = process.cwd();
  process.chdir(workDir);

  // faux provider：手动组装 createFauxCore + registerApiProvider，替代 registerFauxProvider。
  // 原因：faux 内置 stream 实现跳过 streamOptions.onPayload，导致 before_provider_request
  // 事件链（Payload Guard）在 L1 从未参与 —— 覆盖缺口。
  // 这里对齐真实适配器（如 openai-completions）：请求前先走 onPayload，
  // 并把清理后的 payload 回喂给 faux —— capture 记录的就是「provider 实际收到的请求」。
  const fauxCore = createFauxCore({
    models: [{ id: "faux-vision", name: "Faux Vision", input: ["text", "image"] }],
  });
  const fauxSourceId = `faux-guarded-${Math.random().toString(36).slice(2, 10)}`;
  const guardedStream = (
    model: unknown,
    context: unknown,
    streamOptions: { onPayload?: (payload: unknown, model: unknown) => Promise<unknown> } | undefined,
  ) => {
    const outer = createAssistantMessageEventStream();
    void (async () => {
      let ctx = context;
      try {
        const next = await streamOptions?.onPayload?.(context, model);
        if (next !== undefined) ctx = next;
      } catch (err) {
        outer.push({ type: "error", reason: "error", error: err } as never);
        outer.end(err as never);
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: faux 内部类型未在导出中精化
      const inner = fauxCore.stream(model as any, ctx as any, streamOptions as any);
      for await (const event of inner) outer.push(event);
      outer.end(await inner.result());
    })();
    return outer;
  };
  registerApiProvider(
    // biome-ignore lint/suspicious/noExplicitAny: stream 签名对齐内部类型
    { api: fauxCore.api, stream: guardedStream as any, streamSimple: guardedStream as any },
    fauxSourceId,
  );
  const faux = {
    api: fauxCore.api,
    models: fauxCore.models,
    getModel: fauxCore.getModel,
    state: fauxCore.state,
    setResponses: fauxCore.setResponses.bind(fauxCore),
    appendResponses: fauxCore.appendResponses.bind(fauxCore),
    unregister: () => unregisterApiProviders(fauxSourceId),
  };

  const captured: CapturedRequest[] = [];

  // payload capture：每个 response step 执行前先记录 provider 收到的 Context
  const wrap = (steps: FauxResponseStep[]): FauxResponseStep[] =>
    steps.map((step) => {
      if (typeof step !== "function") {
        return (ctx: unknown) => {
          recordCapture(ctx);
          return step;
        };
      }
      return async (ctx: unknown, ...rest: unknown[]) => {
        recordCapture(ctx);
        return (step as (...args: unknown[]) => unknown)(ctx, ...rest);
      };
    });

  const recordCapture = (ctx: unknown): void => {
    let totalBytes = 0;
    try {
      totalBytes = JSON.stringify(ctx).length;
    } catch {
      totalBytes = -1;
    }
    captured.push({
      index: captured.length,
      context: ctx,
      mediaBytes: countMediaBytesInPayload(ctx),
      totalBytes,
    });
  };

  // faux provider 注册为一个内联扩展（与 pi 官方测试同路径）
  const fauxProviderFactory = (pi: ExtensionAPI): void => {
    const model = faux.getModel();
    pi.registerProvider(model.provider, {
      baseUrl: model.baseUrl,
      apiKey: "faux-key",
      api: faux.api,
      models: faux.models.map((m) => ({
        id: m.id,
        name: m.name,
        api: m.api,
        reasoning: m.reasoning,
        input: m.input,
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        baseUrl: m.baseUrl,
      })),
    });
  };

  const services = await createAgentSessionServices({
    cwd: workDir,
    agentDir,
    settingsManager: options.settings
      ? SettingsManager.inMemory(options.settings as never)
      : undefined,
    resourceLoaderOptions: {
      extensionFactories: [
        ...(withPlugin ? [(artifactManagerExtension as unknown as (pi: ExtensionAPI) => void)] : []),
        fauxProviderFactory,
        ...(options.extraFactories ?? []),
      ],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    },
  });

  const sessionManager =
    options.sessionManager ??
    (options.fileSession ? SessionManager.create(workDir) : SessionManager.inMemory());

  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model: faux.getModel(),
  });

  if (options.responses) {
    faux.setResponses(wrap(options.responses));
  } else {
    faux.setResponses([]);
  }

  return {
    workDir,
    session: session as unknown as E2EHarness["session"],
    sessionManager,
    captured,
    setResponses: (steps) => faux.setResponses(wrap(steps)),
    appendResponses: (steps) => faux.appendResponses(wrap(steps)),
    cleanup: async () => {
      try {
        (session as { dispose?: () => void }).dispose?.();
      } catch {}
      faux.unregister();
      process.chdir(prevCwd);
      // 外部 workDir 由测试自行管理（resume 场景需保留）
      if (externalWorkDir) return;
      try {
        fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {}
    },
  };
}

export { fauxAssistantMessage };
