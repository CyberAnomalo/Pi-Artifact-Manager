# pi-artifact-manager

A [Pi coding-agent](https://github.com/earendil-works/pi) extension that solves **multimodal context pollution** in coding harness sessions.

> **第一阶段目标**：解决 Coding Harness 多模态上下文污染问题，同时留下未来扩展 Artifact 系统的接口。

## iOS 分支

`ios` 分支另提供 `pi-artifact-manager/ios`，用于 CameraMan 的持久照片管理。
它复用 artifact ID、生命周期和引用语义，不运行桌面 Pi Agent。
照片字节由 APP 的原生存储处理，Live 预览帧不进入该适配器。

接口、存储责任和测试命令见 [iOS adapter](docs/ios-adapter.md)。
以下桌面 hooks、SQLite、payload guard 和字节恢复说明不适用于 iOS 适配器。

## 问题

长会话中历史图片以原始字节形式反复进入 LLM 请求：上传一张截图后，之后每一轮都为它重复付费，上下文被无关媒体污染，最终撑爆上下文窗口。

## 方案

**图片生命周期管理优先于语义管理**，全部确定性逻辑，不依赖 LLM 分类：

1. **input hook** — 用户图片到达即 ingest：sha256 → blob 去重存储 → metadata 入库 → `artifact_<hash>` id
2. **context hook** — 历史轮的图片替换为 `[Artifact Reference]` 文本块（id + summary），当前轮图片允许一次（allowed once）
3. **payload guard** — `before_provider_request` 最后防线：扫描 `data:image` / `input_image` / `base64` / `image_url`，普通文本轮允许 **0 image bytes**，检测失败即剥离（禁止发送）
4. **按需恢复** — 模型通过 `artifact_get(id)` 把图片重新加载进当前轮

## 架构

```
pi-artifact-manager/
├── index.ts                  # 入口（转发到 src/extension）
├── src/
│   ├── ios/                  # CameraMan 适配器，不加载桌面 Pi runtime
│   ├── extension/
│   │   ├── index.ts          # 扩展组装：hooks + tools + /artifact 命令
│   │   ├── hooks.ts          # input/context/guard/session hooks
│   │   ├── context.ts        # Context Manager（历史图片 → artifact 引用）
│   │   ├── guard.ts          # Payload Guard（audit 抛错 / sanitize 剥离）
│   │   └── policy.ts         # MediaPolicy + HistoricalMediaLeakError
│   ├── core/                 # 独立于 Pi，可单独测试
│   │   ├── store.ts          # ArtifactStore 门面（ingest/list/get/transition）
│   │   ├── artifact.ts       # Artifact 类型 + id 生成
│   │   ├── blob.ts           # BlobStore（sha256 内容寻址 + 去重）
│   │   ├── database.ts       # SQLite 薄封装（bun:sqlite / node:sqlite 双后端）
│   │   ├── lifecycle.ts      # CREATED→ACTIVE→CONSUMED→ARCHIVED 状态机
│   │   └── placeholders.ts   # 未实现功能的接口保留
│   ├── db/schema.sql         # SQLite schema（含未来表 PLACEHOLDER）
│   └── tools/                # artifact_list / artifact_get / artifact_stats
├── tests/                    # unit / e2e（L1）/ l2（真实 CLI）/ benchmark
└── scripts/dedupe-pi.mjs     # postinstall：消除 npm 嵌套副本
```

### 存储布局

```
.visual-artifacts/
├── database.sqlite
├── blobs/sha256/<前2位>/<hash>.<ext>   # 同图 100 次上传 = 1 份 blob
├── thumbnails/    (PLACEHOLDER)
├── temp/
└── exports/       (PLACEHOLDER)
```

### Agent 工具

| 工具 | 作用 |
|---|---|
| `artifact_list` | 查看所有 artifact（id / size / summary / status） |
| `artifact_get(id)` | 把归档图片重新加载进当前请求 |
| `artifact_stats` | 统计：数量 / 存储字节 / 拦截的历史媒体字节 |

PLACEHOLDER（未来）：`artifact_compare` / `artifact_branch` / `artifact_tag` / `artifact_merge` / `artifact_export`

## 安装（开发中）

```bash
pi install -l /path/to/pi-artifact-manager
# 或一次性运行:
pi -e /path/to/pi-artifact-manager/index.ts
```

## 开发与验证

```bash
npm install              # postinstall 自动去重 pi 依赖嵌套副本
npm run typecheck        # tsc --noEmit
npm test                 # 全部：unit + e2e + l2 + benchmark，以运行报告为准
npm run test:unit        # 单元层
npm run test:e2e         # L1 真实 pi 运行时层
npm run test:l2          # L2 真实 CLI + mock provider（真实 HTTP 出口）
npm run test:bench       # 基准层
```

所有测试均不需要真实 AI API（faux provider / mock HTTP server）。

### 三层实验体系（证明「媒体没有泄漏到 provider payload」）

```
tests/
├── unit/          # payload-guard（fail-closed + 预算强制）/ context-rewrite / blob-store / tools / placeholders / extension-entry
├── e2e/           # L1：真实 pi 运行时 + faux provider payload 捕获
│   ├── E1-leak-growth   # A/B 泄漏曲线（含无插件失败基线）
│   ├── E2-multi-image   # Req 1：多图后历史媒体 = 0（含 100 图字面标准）
│   ├── E3-resume        # Req 2：重启 resume 不重放
│   ├── E4-hydration     # Req 3：artifact_get 字节级恢复
│   ├── E5-adversarial   # 同轮多请求 retry 语义 / compact 后不复活
│   └── E7-multi-entry   # 用户输入 / toolResult 多入口归零
├── l2/            # L2：真实 CLI 进程 + mock HTTP provider
│   ├── mock-server.ts        # 本地 OpenAI 兼容 SSE server，请求原样落盘
│   └── l2.test.ts            # A/B：带插件 turn2 = 0 字节；无插件重放（生产缺陷确认）
└── benchmark/     # RAR（重放放大比）/ Payload Growth Curve / Resume 成本
```

**L1 e2e 的证据链**：扩展经 pi 真实 resource loader 加载，hooks 走真实事件链；
faux provider 收到的 `Context` 就是 provider 实际请求 —— 媒体字节是否到达模型端由此直接断言。

**L2 的证据链**（生产行为验证）：真实 pi CLI 子进程 + 真实 HTTP 序列化，
mock server 落盘的请求体就是线上会发出的字节。关键工程细节：
print 模式必须断开 stdin（`stdio: ["ignore", ...]`）；@file 附件按 magic bytes 识别，
测试用内置 PNG 生成器（tests/helpers.ts `makeRealPng`）产出合法图片。

### 核心量化指标

- **RAR**（Media Replay Amplification Ratio）= 累计发送媒体字节 / 唯一输入媒体字节：无插件 ≈ 轮数（O(n)），有插件 = 1
- **Payload Growth**：无插件线性增长；有插件 turn ≥ 2 恒为 0 媒体字节

### MVP 完成标准（均有可执行断言）

- **Req 1** — 多图后 `continue`：provider 请求 historical media = 0（unit + e2e E2）
- **Req 2** — 重启 resume 成功，blob 不入内存（unit + e2e E3）
- **Req 3** — `artifact_get()` 字节级恢复图片（unit + e2e E4）
- **Req 4** — guard fail-closed：`audit()` 抛 `HistoricalMediaLeakError`；生产路径 `sanitize()` 剥离（unit）

### 已知环境问题（已自动处理）

npm 会在 pi-coding-agent 下嵌套安装 pi-ai 副本，导致双实例全局 registry 分裂
（faux provider 对 agent 不可见）。`postinstall` 钩子（scripts/dedupe-pi.mjs）自动删除嵌套副本。

## 明确不做（PLACEHOLDER）

自动语义分类、Revision DAG、Branch、图片 Diff、多 harness 适配（Codex/OpenCode）、独立 sidecar daemon —— 接口已保留在 [src/core/placeholders.ts](src/core/placeholders.ts)。

## 参考仓库

- **pi 主仓库**: https://github.com/earendil-works/pi
- **pi-condense**（结构参考）: https://github.com/jjuraszek/pi-condense

## License

MIT
