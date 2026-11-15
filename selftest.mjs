/**
 * selftest.mjs — 证明这个校验器真的能挡住"一装就挂"的插件。
 *
 * 三条：
 *  A. 一个故意写坏的插件（`required: true` 在属性上）必须被判红，且错误信息点名 required。
 *  B. 真实插件 win-shell-dsh-plugin 必须通过。
 *  C. 真实插件 qihuang-icon-standard 必须通过（它带 skill + prompt section）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkPlugin } from "./lib/check.mjs";

let failures = 0;
const expect = (label, ok, extra = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  ${extra}`}`);
  if (!ok) failures += 1;
};

/** 造一个临时插件模块并导入。 */
async function loadTempPlugin(source) {
  const dir = mkdtempSync(join(tmpdir(), "schema-check-"));
  const file = join(dir, "index.mjs");
  writeFileSync(file, source, "utf8");
  return import(pathToFileURL(file).href);
}

console.log("== [A] 写坏 required 的插件必须被判红 ==");
{
  const bad = await loadTempPlugin(`
export const name = "bad-plugin";
export function apply(ctx) {
  ctx.tools.register({
    name: "bad_tool",
    description: "这是一个参数 schema 故意写坏的示例工具，required 被错误地写成布尔值",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string", required: true, description: "路径" } },
      required: ["path"],
    },
    output: { schema: { type: "object" }, render: () => [{ type: "text", text: "x" }] },
    execute: () => ({}),
  });
}
`);
  const report = await checkPlugin(bad, { label: "bad-plugin" });
  expect("判为未通过", report.ok === false);
  expect("错误点名 required", report.errors.some((error) => error.includes("required") && error.includes("字符串数组")), report.errors.join(" | "));
  console.log(`     → ${report.errors[0]}`);
}

console.log("\n== [B] 根节点不是 object 也要判红 ==");
{
  const bad = await loadTempPlugin(`
export function apply(ctx) {
  ctx.tools.register({
    name: "flat_tool",
    description: "把参数平铺在顶层、没有 type/properties 的示例工具，投影会失败",
    parameters: { path: { type: "string" } },
    output: { schema: { type: "object" }, render: () => [] },
    execute: () => ({}),
  });
}
`);
  const report = await checkPlugin(bad);
  expect("判为未通过", report.ok === false, report.errors.join(" | "));
  expect("点名 parameters.type", report.errors.some((error) => error.includes("parameters.type")), report.errors.join(" | "));
}

console.log("\n== [C] apply() 抛错的插件必须判红并带堆栈 ==");
{
  const bad = await loadTempPlugin(`
export function apply() {
  throw new Error("boom in apply");
}
`);
  const report = await checkPlugin(bad);
  expect("判为未通过", report.ok === false, report.errors.join(" | "));
  expect("带装配异常信息", report.errors[0].includes("apply()"), report.errors[0]);
}

console.log("\n== [D] 真实插件：win-shell-dsh-plugin ==");
{
  const file = resolve("../win-shell-dsh-plugin/src/index.js");
  const module = await import(pathToFileURL(file).href);
  const report = await checkPlugin(module, { label: "win-shell-dsh-plugin" });
  expect("通过", report.ok, report.errors.join(" | "));
  expect("识别出 3 个工具", report.tools.length === 3, report.tools.join(","));
}

console.log("\n== [E] 真实插件：qihuang-icon-standard ==");
{
  const file = resolve("../../game/dsh-plugins/icon-standard/index.js");
  const module = await import(pathToFileURL(file).href);
  const report = await checkPlugin(module, { label: "@luminsw/icon-standard" });
  expect("通过", report.ok, report.errors.join(" | "));
  expect("识别出 3 个工具 + 1 个 skill", report.tools.length === 3 && report.skills.length === 1, `${report.tools.length}/${report.skills.length}`);
  expect("识别出 prompt section", report.sections.includes("icon:standard"), report.sections.join(","));
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURES`}`);
process.exit(failures === 0 ? 0 : 1);
