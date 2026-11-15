# dsh-plugin-schema-check

DSH 插件的**装配期校验器**：用一个假 ctx 真跑一遍 `apply()`，把注册出来的工具、技能、prompt section 全部拦下来做静态检查。

用途很具体：**挡住"装上才发现会挂"的插件**。

## 它治的病

DSH 在注册工具时会校验参数 schema。一旦 schema 非法，注册当场抛错——而那一刻是在插件装配期，表现是**整个会话挂掉**，不是一条测试失败。

最经典的非法写法（我自己在两个插件里连续犯过）：

```js
parameters: {
  type: "object",
  properties: {
    path: { type: "string", required: true },  // ❌ 非法：required 在属性上必须是字符串数组
  },
  required: ["path"],
}
```

这种事 code review 拦不住，单元测试也覆盖不到（测试通常只 import 内部函数，不会调 `apply()`）。所以把它变成一条命令：

```bash
node ../dsh-plugin-schema-check/cli.mjs .
```

## 检查项

| 级别 | 检查 |
| --- | --- |
| ❌ | `apply()` 抛出异常（装配期即会拖垮会话，带堆栈） |
| ❌ | `parameters.type` 不是 `object`（含"参数平铺在顶层"这种写法） |
| ❌ | 任意层级的 `required` 不是字符串数组（`required: true` 就在这里被抓） |
| ❌ | `required` 引用了不存在的属性 |
| ❌ | 属性没有类型约束（`type`/`enum`/`anyOf`/`$ref`/`items` 全缺） |
| ❌ | 缺 `output.schema` 或 `output.render` |
| ❌ | 工具名不是 `lower_snake` / 重名 |
| ❌ | `description` 为空 / prompt section 缺 `name`、`order` 非数字 |
| ❌ | skill 名不是 kebab-case |
| ⚠️ | `description` 过短、skill 正文过短、访问了未建模的服务（按桩处理，行为未校验） |

## 用法

### 命令行

```bash
node cli.mjs ../win-shell-dsh-plugin
# 或有 bin 之后：dsh-plugin-schema-check <pluginDir>
```

退出码 0 = 通过，1 = 未通过，可直接接进 npm script 或 CI。

### 编程接口

```js
import { checkPlugin, formatReport } from "dsh-plugin-schema-check";
import { pathToFileURL } from "node:url";

const module = await import(pathToFileURL("./src/index.js").href);
const report = await checkPlugin(module, { label: "my-plugin" });
if (!report.ok) {
  console.error(formatReport(report));
  process.exit(1);
}
```

## 已知边界

- 只支持 `export function apply(ctx, config)` 形式；`export default class Service` 形式会报"暂不支持"。
- 假 ctx 只建模了 `tools / skills / systemPrompt / webServer / workingDirectory / subprocess / commands`；
  其它服务返回"什么都能调、都返回 undefined"的桩，并记一条警告。
- 装配期**不会真的执行任何命令**：`subprocess.spawn` 被替换成抛错，防止校验时误跑东西。
- 如果插件的入口 import 了 `@deepseek-ai/*` 包（例如用 `defineTool`），需要在能解析这些包的环境里跑
  （比如 dsh 安装目录的 node_modules），否则导入会失败并提示。

## 自测

```bash
node selftest.mjs
```

覆盖：写坏 `required` 的插件必被判红、参数平铺必被判红、`apply()` 抛错必带堆栈、两个真实插件
（`win-shell-dsh-plugin`、`@luminsw/icon-standard`）必须通过且被正确识别出工具/技能/section。
