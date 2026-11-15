/**
 * check.mjs — 在**不启动 DSH** 的前提下，模拟一次插件装配，校验它能被 harness 投影。
 *
 * 为什么需要它：DSH 的插件在 apply() 里注册工具，注册时 harness 会校验参数 schema。
 * 一旦 schema 非法（最经典的是把 `required: true` 写进属性定义——JSON Schema 里
 * `required` 在属性上必须是字符串数组），注册即抛错，而错误发生在装配期，表现是整个
 * 会话挂掉。那个失败点离单元测试很远，靠 code review 根本挡不住。
 *
 * 本模块用假的 ctx 跑一遍 apply()，把注册出来的东西全部拦下来做静态校验。
 */

/**
 * 建一个"够用且会记账"的假 ctx。
 * @param {object} record - 收集器。
 * @returns {object} 假 ctx。
 */
function createFakeContext(record) {
  /**
   * 未知服务的兜底：记录访问，返回一个什么都能调、都返回 undefined 的桩。
   * @param {string} name - 服务名。
   * @returns {Proxy} 桩。
   */
  const unknownService = (name) =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          record.unknownServices.add(`${name}.${String(property)}`);
          return (..._args) => undefined;
        },
      },
    );

  const known = {
    tools: {
      register: (definition) => {
        if (!definition || typeof definition !== "object") {
          throw new TypeError("tools.register: definition 必须是对象（真实 registry 也会在此失败）");
        }
        record.tools.push(definition);
        return () => {};
      },
      restrict: () => () => {},
      guard: () => () => {},
      get: () => undefined,
    },
    skills: {
      register: (skill) => {
        record.skills.push(skill);
        return () => {};
      },
      registerProvider: () => () => {},
    },
    systemPrompt: {
      section: (section) => {
        record.sections.push(section);
        return () => {};
      },
      context: (context) => {
        record.contexts.push(context);
        return () => {};
      },
      tools: () => () => {},
      variable: () => () => {},
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
    },
    workingDirectory: {
      get: () => process.cwd(),
      set: async () => process.cwd(),
      ensure: async () => process.cwd(),
    },
    webServer: {
      register: (route) => {
        record.routes.push(route);
        return () => {};
      },
      registerFallback: () => () => {},
      tapIndex: () => () => {},
    },
    subprocess: {
      spawn: () => {
        throw new Error("schema-check: 装配期不应真的执行命令");
      },
    },
    commands: {
      register: (command) => {
        record.commands.push(command);
        return () => {};
      },
    },
  };

  const base = {
    get: (name) => known[name] ?? unknownService(name),
    effect: (callback) => {
      const disposer = callback();
      record.disposers.push(disposer);
      return () => {};
    },
    on: () => () => {},
    emit: () => {},
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  };
  // 插件既可能 `ctx.tools.register(...)` 也可能 `ctx.get('tools')`：
  // 用 Proxy 让两种写法都命中同一批桩，未知服务则记账后返回兜底桩。
  return new Proxy(base, {
    get: (target, property) => {
      if (typeof property === "symbol" || property === "then" || property === "toJSON") return undefined;
      if (property in target) return target[property];
      if (known[property]) return known[property];
      return unknownService(String(property));
    },
  });
}

/**
 * 递归找 schema 里的非法关键字。
 * @param {unknown} node - schema 节点。
 * @param {string} at - 位置描述。
 * @param {string[]} problems - 收集器。
 * @param {string[]} propertyNames - 当前层的属性名（用于校验 required 引用）。
 * @returns {string[]} 问题列表。
 */
function walkSchema(node, at, problems, propertyNames = null) {
  if (node === null || typeof node !== "object") return problems;

  if (Object.hasOwn(node, "required")) {
    const value = node.required;
    const isStringArray = Array.isArray(value) && value.every((item) => typeof item === "string");
    if (!isStringArray) {
      problems.push(
        `${at}.required 必须是字符串数组，实际是 ${JSON.stringify(value)}` +
          "（把 `required: true` 写在属性定义里是非法 JSON Schema，注册时会抛错并拖垮会话）",
      );
    } else if (propertyNames) {
      for (const name of value) {
        if (!propertyNames.includes(name)) problems.push(`${at}.required 引用了不存在的属性 \`${name}\``);
      }
    }
  }

  if (Object.hasOwn(node, "properties") && node.properties && typeof node.properties === "object") {
    const names = Object.keys(node.properties);
    for (const [key, child] of Object.entries(node.properties)) {
      const childAt = `${at}.properties.${key}`;
      const typed =
        child && typeof child === "object"
          ? ["type", "enum", "const", "anyOf", "oneOf", "allOf", "$ref", "items"].some((k) => Object.hasOwn(child, k))
          : false;
      if (!typed) problems.push(`${childAt} 没有类型约束（需要 type/enum/anyOf/…）`);
      walkSchema(child, childAt, problems, null);
    }
    // required 与 properties 同级：本层已处理，这里换用属性名再走一遍
    if (Object.hasOwn(node, "required") && Array.isArray(node.required)) {
      for (const name of node.required) {
        if (typeof name === "string" && !names.includes(name)) {
          problems.push(`${at}.required 引用了不存在的属性 \`${name}\``);
        }
      }
    }
    return problems;
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "required") continue;
    walkSchema(value, `${at}.${key}`, problems, null);
  }
  return problems;
}

/**
 * 校验一个已注册的工具定义。
 * @param {object} definition - 工具定义。
 * @param {number} index - 序号（用于定位）。
 * @param {object} report - 报告收集器。
 * @param {Set<string>} seenNames - 已出现的工具名。
 */
function checkTool(definition, index, report, seenNames) {
  const label = `tools[${index}]${definition?.name ? `(${definition.name})` : ""}`;
  if (!definition || typeof definition !== "object") {
    report.errors.push(`${label} 不是对象`);
    return;
  }
  if (typeof definition.name !== "string" || !/^[a-z][a-z0-9_]*$/.test(definition.name)) {
    report.errors.push(`${label}.name 必须是 kebab/下划线小写标识符，实际 ${JSON.stringify(definition.name)}`);
  } else if (seenNames.has(definition.name)) {
    report.errors.push(`${label}.name 重复：${definition.name}`);
  } else {
    seenNames.add(definition.name);
  }
  if (typeof definition.description !== "string" || definition.description.trim() === "") {
    report.errors.push(`${label}.description 不能为空`);
  } else if (definition.description.length < 30) {
    report.warnings.push(`${label}.description 偏短（${definition.description.length} 字符），模型难以判断何时该调用`);
  }

  const parameters = definition.parameters;
  if (!parameters || typeof parameters !== "object") {
    report.errors.push(`${label}.parameters 缺失（应为 JSON Schema 对象）`);
  } else {
    if (parameters.type !== "object") report.errors.push(`${label}.parameters.type 必须是 'object'`);
    const propertyNames = parameters.properties && typeof parameters.properties === "object" ? Object.keys(parameters.properties) : [];
    walkSchema(parameters, `${label}.parameters`, report.errors, propertyNames);
    if (Object.hasOwn(parameters, "required") && !propertyNames.length) {
      report.warnings.push(`${label}.parameters 声明了 required 但没有 properties`);
    }
  }

  if (!definition.output || typeof definition.output !== "object") {
    report.errors.push(`${label}.output 缺失（需要 { schema, render }）`);
  } else {
    if (!definition.output.schema || typeof definition.output.schema !== "object") {
      report.errors.push(`${label}.output.schema 缺失`);
    }
    if (typeof definition.output.render !== "function") {
      report.errors.push(`${label}.output.render 必须是函数`);
    }
  }

  if (typeof definition.execute !== "function") report.errors.push(`${label}.execute 必须是函数`);
}

/**
 * 跑一遍插件装配并校验注册物。
 * @param {{apply?: Function, default?: unknown, name?: string}} module - 插件模块。
 * @param {{label?: string}} [options] - 选项。
 * @returns {Promise<{ok: boolean, label: string, tools: string[], skills: string[], sections: string[],
 *   errors: string[], warnings: string[]}>} 校验结果。
 */
export async function checkPlugin(module, options = {}) {
  const report = {
    ok: true,
    label: options.label ?? module?.name ?? "(plugin)",
    tools: [],
    skills: [],
    sections: [],
    errors: [],
    warnings: [],
  };
  const record = {
    tools: [],
    skills: [],
    sections: [],
    contexts: [],
    routes: [],
    commands: [],
    disposers: [],
    unknownServices: new Set(),
  };

  const applyFn = typeof module?.apply === "function" ? module.apply : null;
  if (!applyFn) {
    report.errors.push("模块没有导出 apply(ctx) 函数，无法做装配校验（service class 形式暂不支持）");
    report.ok = false;
    return report;
  }

  const ctx = createFakeContext(record);
  try {
    await applyFn(ctx, {});
  } catch (error) {
    report.errors.push(`apply() 抛出异常（装配期即会拖垮会话）：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    report.ok = false;
    return report;
  }

  const seenNames = new Set();
  record.tools.forEach((definition, index) => checkTool(definition, index, report, seenNames));

  if (record.tools.length === 0) {
    report.warnings.push("没有注册任何工具（如果这是纯 UI/纯服务插件可忽略）");
  }
  for (const skill of record.skills) {
    if (typeof skill?.name !== "string" || !/^[a-z][a-z0-9-]*$/.test(skill.name)) {
      report.errors.push(`skill 名必须是 kebab-case：${JSON.stringify(skill?.name)}`);
    }
    if (typeof skill?.content !== "string" || skill.content.length < 50) {
      report.warnings.push(`skill ${skill?.name} 正文偏短（${skill?.content?.length ?? 0} 字符）`);
    }
  }
  for (const section of record.sections) {
    if (typeof section?.name !== "string" || section.name.trim() === "") report.errors.push("prompt section 缺 name");
    if (typeof section?.order !== "number") report.errors.push(`prompt section ${section?.name} 的 order 必须是数字`);
    if (typeof section?.text !== "string" && typeof section?.text !== "function") {
      report.errors.push(`prompt section ${section?.name} 的 text 必须是字符串或函数`);
    }
  }
  if (record.unknownServices.size > 0) {
    report.warnings.push(`访问了未建模的服务：${[...record.unknownServices].join(", ")}（按桩处理，实际行为未校验）`);
  }

  report.tools = [...seenNames];
  report.skills = record.skills.map((skill) => skill?.name).filter(Boolean);
  report.sections = record.sections.map((section) => section?.name).filter(Boolean);
  report.ok = report.errors.length === 0;
  return report;
}

/**
 * 把校验结果渲染成多行文本。
 * @param {object} report - checkPlugin 的返回值。
 * @returns {string} 文本。
 */
export function formatReport(report) {
  const lines = [`# 插件装配校验 · ${report.label}`, report.ok ? "✅ 通过" : "❌ 未通过", ""];
  if (report.tools.length) lines.push(`工具 (${report.tools.length}): ${report.tools.join(", ")}`);
  if (report.skills.length) lines.push(`技能 (${report.skills.length}): ${report.skills.join(", ")}`);
  if (report.sections.length) lines.push(`prompt section: ${report.sections.join(", ")}`);
  if (report.errors.length) {
    lines.push("", "## 错误");
    for (const error of report.errors) lines.push(`- ❌ ${error}`);
  }
  if (report.warnings.length) {
    lines.push("", "## 警告");
    for (const warning of report.warnings) lines.push(`- ⚠️ ${warning}`);
  }
  return lines.join("\n");
}
