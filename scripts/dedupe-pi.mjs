/**
 * postinstall 钩子：消除 npm 在 pi-coding-agent 下嵌套安装的
 * @earendil-works/* 与 typebox 副本。
 *
 * 背景：pi-ai 内部有模块级全局 apiProviderRegistry。若测试与
 * pi-coding-agent 各自解析到不同副本（双实例），faux provider
 * 注册的 api 对 agent 不可见（"No API provider registered"）。
 * 删除嵌套副本后，pi-coding-agent 回退解析到顶层唯一实例。
 */

import * as fs from "node:fs";
import * as path from "node:path";

const root = process.cwd();
const nestedBase = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules");

const targets = [path.join(nestedBase, "@earendil-works"), path.join(nestedBase, "typebox")];

for (const target of targets) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`[dedupe-pi] removed nested copy: ${path.relative(root, target)}`);
  }
}
