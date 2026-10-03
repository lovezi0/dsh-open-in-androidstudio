// 浏览器半边离线自测：在 vm 沙箱里执行构建产物 lib/client.js（同时验证产物与源一致），
// 用假客户端 ctx + 假 fetch 驱动 apply：多版本逐条注册、参数符合底座契约、
// 取数失败降级为空清单、卸载即反注册、插件管理面板里的配置区块注册与读写。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const BUNDLE = readFileSync(new URL("lib/client.js", root), "utf8");

// ---- 假 React（按序复用的钩子槽 + 手动冲刷 effect） ----

let hookSlots = {};
let hookIdx = 0;
let effectQueue = [];

const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined),
  }),
  useState: (init) => {
    const index = hookIdx++;
    if (!(index in hookSlots)) hookSlots[index] = { value: typeof init === "function" ? init() : init };
    const slot = hookSlots[index];
    return [slot.value, (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; }];
  },
  useEffect: (fn) => { effectQueue.push(fn); },
};

// 平台单例只留下类型名，便于在渲染树里按类型查找。
const primitives = { Button: "Button", Input: "Input" };

const settle = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

// ---- 装载 client bundle ----

let currentFetch = () => Promise.reject(new Error("fetch not stubbed"));
let captured = null;
const fetchCalls = [];
const sandbox = {
  window: { __ModuleLoader__: { load: (definition) => { captured = definition; } } },
  console,
  fetch: (input, init) => {
    fetchCalls.push({ url: String(input), options: init });
    return currentFetch(input, init);
  },
};
vm.createContext(sandbox);
vm.runInContext(BUNDLE, sandbox, { filename: "lib/client.js" });

assert.ok(captured, "module registered via __ModuleLoader__");
assert.equal(captured.id, pkg.name, "registered id equals the package name");

// 宿主契约：工厂拿到的 require 只能取冻结模块表里的平台单例，其余一律不可取用。
const clientExports = captured.factory((name) => {
  if (name === "react") return React;
  if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
  throw new Error(`unexpected require: ${name}`);
});

assert.equal(typeof clientExports.apply, "function", "apply exported");
assert.equal(clientExports.inject, undefined, "top level declares no hard dependency on the base");

const TARGETS_ROUTE = "open-in-androidstudio/targets";
const VERSION_PREFIX = "open-in-androidstudio/v";
const SETTINGS_ROUTE = "open-in-androidstudio/settings";

// ---- 假客户端 ctx：底座已装配的那个世界 ----

function makeEnv({ withBase = true, withSlots = true } = {}) {
  const registered = [];
  const released = [];
  const disposers = [];
  const scope = {
    effect: (fn, label) => { disposers.push({ label, dispose: fn() }); return () => {}; },
    openInAppTargets: {
      register: (target) => {
        registered.push(target);
        return () => { released.push(target.id); };
      },
    },
  };
  const slotRequests = [];
  const slotRegistrations = [];
  const slotsScope = {
    slots: {
      inject: (slotName, callback) => { slotRequests.push(slotName); return callback(); },
      register: (options, component) => { slotRegistrations.push({ options, component }); return () => {}; },
    },
  };
  let pending = null;
  const ctx = {
    // 模拟 cordis ctx.inject：依赖在场即视为服务就绪、执行回调（回调是 async，宿主会等它）；
    // 缺席则回调不执行，子 fiber 停在等待。
    inject: (deps, callback) => {
      const key = JSON.stringify(deps);
      if (key === JSON.stringify(["openInAppTargets"])) {
        if (withBase) pending = callback(scope);
        return;
      }
      if (key === JSON.stringify(["slots"])) {
        if (withSlots) callback(slotsScope);
        return;
      }
      throw new Error(`unexpected inject: ${key}`);
    },
  };
  clientExports.apply(ctx);
  return { pending, registered, released, disposers, slotRequests, slotRegistrations };
}

async function loaded(options) {
  const env = makeEnv(options);
  await env.pending;
  return env;
}

function jsonResponse(payload, ok = true) {
  return { ok, json: async () => payload };
}

// ---- 场景 1：apply 同步返回，异步取数归子 fiber ----

{
  currentFetch = () => new Promise(() => {});
  const env = makeEnv();
  // 沙箱内的 Promise 与外部构造函数不同源，按 thenable 判定。
  assert.ok(env.pending !== null && typeof env.pending.then === "function", "the child fiber owns an async body");
  assert.equal(env.registered.length, 0, "apply returns before the version list arrives");
  console.log("client-selftest: scenario 1 (apply returns synchronously) passed");
}

// ---- 场景 2：多版本逐条注册，参数满足底座契约 ----

{
  currentFetch = (input) => {
    assert.equal(input, TARGETS_ROUTE, "client reads the version list from the host endpoint");
    return Promise.resolve(jsonResponse({ ok: true, targets: [
      { id: "2024.2.1.10", label: "Android Studio (2024.2.1.10)" },
      { id: "2024.1.1.12", label: "Android Studio (2024.1.1.12)" },
    ] }));
  };
  const env = await loaded();
  assert.equal(env.registered.length, 2, "one target per installed version");
  assert.deepEqual(
    env.registered.map((target) => target.id),
    ["androidstudio-2024.2.1.10", "androidstudio-2024.1.1.12"],
    "ids are namespaced and keep the host order",
  );
  assert.deepEqual(
    env.registered.map((target) => target.route),
    [`${VERSION_PREFIX}/2024.2.1.10`, `${VERSION_PREFIX}/2024.1.1.12`],
    "each target points at its own version route",
  );
  assert.deepEqual(env.registered.map((target) => target.order), [0, 1], "order follows the newest-first host order");
  assert.deepEqual(
    env.registered.map((target) => target.label),
    ["Android Studio (2024.2.1.10)", "Android Studio (2024.1.1.12)"],
    "labels come from the host verbatim",
  );
  for (const target of env.registered) {
    assert.ok(Array.isArray(target.icon) && target.icon.length > 0
      && target.icon.every((d) => typeof d === "string" && d.trim().length > 0), "icon is a path-data array");
    assert.ok(!target.route.startsWith("/") && !target.route.includes("://"), "route is a document-relative path");
  }
  assert.equal(env.disposers.length, 1, "all registrations hang off one effect");
  assert.equal(env.disposers[0].label, "open-in-androidstudio: open targets");
  assert.equal(env.released.length, 0, "nothing released while the plugin stays loaded");
  console.log("client-selftest: scenario 2 (registration contract) passed");
}

// ---- 场景 3：插件卸载 → 每个版本随之反注册 ----

{
  currentFetch = () => Promise.resolve(jsonResponse({ ok: true, targets: [
    { id: "a", label: "Android Studio (A)" },
    { id: "b", label: "Android Studio (B)" },
  ] }));
  const env = await loaded();
  env.disposers[0].dispose();
  assert.deepEqual(env.released, ["androidstudio-a", "androidstudio-b"], "unload releases every registered target");
  console.log("client-selftest: scenario 3 (unload releases all targets) passed");
}

// ---- 场景 4：取数失败或数据不合格 → 静默无目标，绝不把坏数据塞进菜单 ----

{
  const cases = [
    ["network failure", () => Promise.reject(new Error("network down"))],
    ["non-2xx response", () => Promise.resolve({ ok: false, json: async () => ({}) })],
    ["non-array payload", () => Promise.resolve(jsonResponse({ ok: true, targets: "nope" }))],
    ["empty list", () => Promise.resolve(jsonResponse({ ok: true, targets: [] }))],
    ["all entries malformed", () => Promise.resolve(jsonResponse({ ok: true, targets: [{ id: "x" }, { label: "y" }, null] }))],
  ];
  for (const [label, impl] of cases) {
    currentFetch = impl;
    const env = await loaded();
    assert.equal(env.registered.length, 0, `no target registered on ${label}`);
    assert.equal(env.disposers.length, 0, `no effect armed on ${label}`);
  }
  currentFetch = () => Promise.resolve(jsonResponse({ ok: true, targets: [
    { id: "ok", label: "Android Studio (OK)" },
    { id: "   ", label: "   " },
    null,
  ] }));
  const env = await loaded();
  assert.deepEqual(env.registered.map((target) => target.id), ["androidstudio-ok"], "valid entries survive while malformed ones drop out");
  console.log("client-selftest: scenario 4 (failed reads degrade to no targets) passed");
}

// ---- 场景 5：内联图标与 assets 源文件逐条一致 ----

{
  currentFetch = () => Promise.resolve(jsonResponse({ ok: true, targets: [{ id: "v", label: "Android Studio (V)" }] }));
  const svg = readFileSync(new URL("../assets/androidstudio-line.svg", import.meta.url), "utf8");
  const paths = [...svg.matchAll(/d="([^"]+)"/g)].map((match) => match[1]);
  const icon = (await loaded()).registered[0].icon;
  assert.equal(paths.length, icon.length, "asset path count matches the inline icon");
  for (const d of paths) {
    assert.ok(icon.includes(d), `asset path inlined verbatim: ${d.slice(0, 24)}…`);
  }
  console.log("client-selftest: scenario 5 (inline icons match assets) passed");
}

// ---- 场景 6：底座缺席（未安装 dsh-open-in-app-base）→ 装配不抛错、零注册 ----

{
  const env = makeEnv({ withBase: false });
  assert.equal(env.pending, null, "the child fiber stays pending without the base");
  assert.equal(env.registered.length, 0, "nothing registered without the base");
  assert.equal(env.disposers.length, 0, "no effect armed without the base");
  console.log("client-selftest: scenario 6 (absent base degrades to a no-op) passed");
}

// ---- 渲染树工具（假 React 的节点结构足够做结构性断言） ----

/** 深度遍历渲染树里的元素节点。 */
function elements(node, out = []) {
  if (node === null || typeof node !== "object") return out;
  out.push(node);
  for (const child of node.children ?? []) elements(child, out);
  return out;
}

const findByType = (tree, type) => elements(tree).filter((node) => node.type === type);

/** 按文本找控件：取 children 里含该文本的第一个节点。 */
const findByText = (tree, text) => elements(tree).find((node) => (node.children ?? []).includes(text));

/** 拼接树里的可见文本，用于断言提示语。 */
const textOf = (tree) => elements(tree)
  .map((node) => (node.children ?? []).filter((child) => typeof child === "string").join(""))
  .filter((text) => text.length > 0)
  .join(" ");

/** 冲刷本次渲染排队的 effect，并等异步取数落地。 */
async function flushEffects() {
  const queue = effectQueue;
  effectQueue = [];
  for (const fn of queue) fn();
  await settle();
}

/** 重置钩子槽并渲染一次配置区块。 */
function renderSection(Section) {
  hookIdx = 0;
  return Section({});
}

// ---- 场景 7：插件管理面板的配置区块按包名为 key 注册 ----

{
  // 底座缺席也不影响面板区块：两者是各自独立的子 fiber。
  const env = makeEnv({ withBase: false });
  assert.deepEqual(env.slotRequests, ["plugins.bundle.config"], "the panel block waits for the slot declaration");
  assert.equal(env.slotRegistrations.length, 1, "exactly one panel block is registered");
  const { options, component } = env.slotRegistrations[0];
  assert.equal(options.name, "plugins.bundle.config", "registered on the plug-in manager slot");
  assert.equal(options.key, pkg.name, "the slot key equals the package name (the host matches bundles by it)");
  assert.equal(typeof component, "function", "a component is provided");
  console.log("client-selftest: scenario 7 (panel config block) passed");
}

// ---- 场景 8：配置区块的读写（载入 → 编辑 → 保存） ----

{
  hookSlots = {};
  hookIdx = 0;
  effectQueue = [];
  fetchCalls.length = 0;
  currentFetch = (input, init) => {
    if (init?.method === "POST") {
      return Promise.resolve(jsonResponse({ ok: true, studioHome: ["C:\\Studio A"] }));
    }
    return Promise.resolve(jsonResponse({
      ok: true,
      studioHome: ["C:\\Studio A"],
      configStudioHome: ["C:\\Profile"],
      writable: true,
    }));
  };
  const Section = makeEnv().slotRegistrations[0].component;

  const loading = renderSection(Section);
  assert.equal(findByType(loading, "Input").length, 0, "no row renders before the settings arrive");
  await flushEffects();

  const loaded = renderSection(Section);
  const inputs = findByType(loaded, "Input");
  assert.equal(inputs.length, 1, "the saved path renders as an input row");
  assert.equal(inputs[0].props.value, "C:\\Studio A", "the input carries the saved value");
  assert.ok(textOf(loaded).includes("另有 1 条路径"), "the profile-config paths are disclosed as read-only");
  assert.ok(!textOf(loaded).includes("未检测到底座"), "no base warning while the base is present");

  findByText(loaded, "添加路径").props.onClick();
  const added = renderSection(Section);
  assert.equal(findByType(added, "Input").length, 2, "adding a row renders another input");

  findByText(added, "保存").props.onClick();
  await settle();
  const posts = fetchCalls.filter((call) => call.options?.method === "POST");
  assert.equal(posts.length, 1, "saving posts once");
  assert.equal(posts[0].url, SETTINGS_ROUTE, "the post targets the host settings route");
  assert.deepEqual(
    JSON.parse(posts[0].options.body),
    { studioHome: ["C:\\Studio A", ""] },
    "the rows are posted verbatim (the host trims and drops empties)",
  );
  assert.equal(posts[0].options.headers["content-type"], "application/json", "the post body is declared as JSON");

  const saved = renderSection(Section);
  assert.ok(textOf(saved).includes("已保存"), "the save result is reported");
  assert.equal(findByType(saved, "Input").length, 1, "the empty row is dropped after a successful save");
  console.log("client-selftest: scenario 8 (panel block reads and saves) passed");
}

// ---- 场景 9：底座缺席时面板只读并说明原因 ----

{
  hookSlots = {};
  hookIdx = 0;
  effectQueue = [];
  fetchCalls.length = 0;
  currentFetch = () => Promise.resolve(jsonResponse({ ok: true, studioHome: [], configStudioHome: [], writable: false }));
  const Section = makeEnv().slotRegistrations[0].component;

  renderSection(Section);
  await flushEffects();
  const tree = renderSection(Section);
  assert.ok(textOf(tree).includes("未检测到底座"), "the missing base is disclosed in the panel");
  assert.equal(findByText(tree, "保存").props.disabled, true, "saving stays disabled while the base is absent");
  assert.equal(findByText(tree, "添加路径").props.disabled, true, "adding rows stays disabled while the base is absent");
  console.log("client-selftest: scenario 9 (panel block degrades without the base) passed");
}

console.log("client-selftest: all scenarios passed");
