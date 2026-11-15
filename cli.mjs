#!/usr/bin/env node
/**
 * cli.mjs — 对一个插件目录做装配期校验。
 *
 * 用法：
 *   node cli.mjs <pluginDir>
 *   npx dsh-plugin-schema-check <pluginDir>
 *
 * 退出码：0 通过，1 未通过（可直接接进 npm scripts / CI）。
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkPlugin, formatReport } from "./lib/check.mjs";

/**
 * 从 package.json 推断入口文件。
 * @param {string} dir - 插件目录。
 * @param {object} pkg - package.json 内容。
 * @returns {string} 绝对路径。
 */
function resolveEntry(dir, pkg) {
  const root = pkg?.exports?.["."];
  const candidates = [
    typeof root === "string" ? root : root?.default,
    pkg?.main,
    "src/index.js",
    "index.js",
    "index.mjs",
  ].filter((value) => typeof value === "string");
  for (const candidate of candidates) {
    return isAbsolute(candidate) ? candidate : join(dir, candidate);
  }
  return join(dir, "src/index.js");
}

const target = resolve(process.argv[2] ?? ".");
let pkg;
try {
  pkg = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
} catch (error) {
  console.error(`读不到 ${join(target, "package.json")}：${error.message}`);
  process.exit(1);
}

const entry = resolveEntry(target, pkg);
let module;
try {
  module = await import(pathToFileURL(entry).href);
} catch (error) {
  console.error(`导入入口失败（${entry}）：${error.message}`);
  console.error("提示：若插件 import 了 @deepseek-ai/* 包，需要在能解析这些包的环境里跑（例如 dsh 安装目录的 node_modules）。");
  process.exit(1);
}

const report = await checkPlugin(module, { label: pkg.name ?? target });
console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
