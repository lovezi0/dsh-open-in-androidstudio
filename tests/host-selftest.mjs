// 宿主半边离线自测：不装载进 DSH，用假 ctx 驱动注册出来的路由处理函数，
// 覆盖围栏、版本清单、版本子路由与入参校验；并校验清单/产物/文档的静态对齐。
// 多版本排序与去重由纯逻辑 buildTargets 直接单测；HTTP 层用单个显式安装根驱动。
// 真实 spawn 会弹 GUI，默认跳过；需要联机验证启动链路时显式 OIA_SELFTEST_SPAWN=1 运行。
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const { apply, name, inject, TARGETS_PATH, SETTINGS_PATH, STATE_KEY, STATE_OWNER, VERSION_PREFIX } =
  await import(new URL("../lib/index.js", import.meta.url).href);
const { buildTargets, collectHomeHints, collectInstallRoots, deriveInstallRoot } = await import(new URL("../lib/targets.mjs", import.meta.url).href);

assert.equal(name, "open-in-androidstudio");
assert.deepEqual(inject, ["webServer", "webRuntime"]);

// ---- 清单与产物对齐 ----

const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
assert.equal(pkg.main, "lib/index.js", "main points at the built host entry");
assert.equal(pkg.exports["."], "./lib/index.js", 'exports["."] matches main');
assert.equal(pkg.exports["./client"], "./lib/client.js", 'exports["./client"] matches the client bundle');
assert.equal(pkg.dsh.client.platform, "web", "the browser half is declared for the web platform");
for (const dep of ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-primitives"]) {
  assert.ok(pkg.dsh.client.inject?.includes(dep) === true, `the client manifest declares ${dep}`);
}
for (const rel of ["lib/index.js", "lib/targets.mjs", "lib/client.js", "cordis.patch.yml", pkg.exports["."], pkg.exports["./client"]]) {
  assert.ok(existsSync(new URL(rel, root)), `built file exists: ${rel}`);
}
for (const rel of ["src/index.mjs", "src/targets.mjs", "src/client/00-head.js", "src/client/10-target.js", "src/client/20-settings.js", "src/client/90-tail.js"]) {
  assert.ok(existsSync(new URL(rel, root)), `source file exists: ${rel}`);
}

// ---- bundle patch 行：只有自身那一行 ----
// 底座既不代插、也不作依赖携带：携带式安装会让 desktop 侧无法卸载底座（实测），
// 底座改为显式安装的前置依赖。此处钉住"没有携带"以防回归。

const patch = readFileSync(new URL(pkg.dsh.bundle.patch, root), "utf8");
const rows = [...patch.matchAll(/^\s*-\s*id:\s*(\S+)\s*$\n^\s*name:\s*'?([^'\s]+)'?\s*$/gm)]
  .map((match) => ({ id: match[1], name: match[2] }));
assert.equal(rows.length, 1, "bundle patch declares exactly one insert row (self)");
const selfRow = rows[0];
assert.equal(selfRow.name, pkg.name, "the insert row targets this package by name");
assert.equal(selfRow.id, name, "insert.id equals the exported cordis service name");
assert.equal(rows.filter((row) => row.name === "dsh-open-in-app-base").length, 0, "the base is not carried as a patch row");
assert.equal(pkg.dependencies?.["dsh-open-in-app-base"], undefined, "the base is not carried as a dependency");

// ---- 安装识别与多版本整理（纯逻辑） ----
// 布局复刻真实共存场景：容器目录（名字像 Studio）下按版本分装，其中旧版没有 product-info.json。

const TMP_ROOT = fileURLToPath(new URL("../tests/.tmp-studio/", import.meta.url));
process.on("exit", () => { try { rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {} });
rmSync(TMP_ROOT, { recursive: true, force: true });
mkdirSync(TMP_ROOT, { recursive: true });

/** 造一个假安装根：目录名即市场版本号；build 省略时模拟没有 product-info.json 的旧版安装。 */
function makeInstall(parent, market, build) {
  const home = join(parent, market);
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", "studio64.exe"), "");
  if (build !== undefined) {
    writeFileSync(join(home, "product-info.json"), JSON.stringify({
      name: "Android Studio",
      version: `AI-${build}`,
      buildNumber: build,
      dataDirectoryName: `AndroidStudio${market}`,
    }));
  }
  return home;
}

const CONTAINER = join(TMP_ROOT, "Android Studio");
const NEW_HOME = makeInstall(CONTAINER, "2025.1.4", "251.27812.49.2514.14217341");
const PREV_HOME = makeInstall(CONTAINER, "2025.1.1", "251.25410.109.2511.13752376");
const LEGACY_HOME = makeInstall(CONTAINER, "3.5.2");
makeInstall(join(TMP_ROOT, "other"), "9.9.9", "999.1");

// 容器布局：只沿像 Studio 的目录下探，普通目录（other）不进结果。
{
  const found = collectInstallRoots(TMP_ROOT, 2, new Set());
  assert.equal(found.size, 3, "container layout yields the three versioned installs");
  assert.ok(found.has(NEW_HOME) && found.has(PREV_HOME) && found.has(LEGACY_HOME), "every versioned install is found");
}

// 整理：版本新者在前，重复与无效项剔除，旧版安装按目录名兜出版本号。
{
  const targets = buildTargets([LEGACY_HOME, NEW_HOME, PREV_HOME, NEW_HOME, `${PREV_HOME}\\`, "Z:\\definitely\\missing\\studio"]);
  assert.equal(targets.length, 3, "invalid and duplicate roots are dropped (trailing separator included)");
  assert.deepEqual(targets.map((target) => target.id), ["2025.1.4", "2025.1.1", "3.5.2"], "newest first, legacy last");
  assert.deepEqual(targets.map((target) => target.label), [
    "Android Studio (2025.1.4)",
    "Android Studio (2025.1.1)",
    "Android Studio (3.5.2)",
  ], "labels carry the market version");
  assert.equal(targets[0].home, NEW_HOME, "the target keeps its install root");
  assert.equal(targets[2].version, "3.5.2", "a legacy install without product-info falls back to the directory name");
}

// ---- 常见安装布局矩阵（模拟其他用户的机器，与开发机布局无关） ----
// 每种布局在临时目录里复原，断言识别逻辑都能命中；新增布局支持时在这里补一行用例。

const MATRIX = join(TMP_ROOT, "matrix");

/** 在 <MATRIX>/<parts...> 下造一个安装根；exe 可指定，build 省略即模拟无 product-info 的旧版。 */
function placeLayout(parts, option = {}) {
  const home = join(MATRIX, ...parts);
  mkdirSync(join(home, "bin"), { recursive: true });
  writeFileSync(join(home, "bin", option.exe ?? "studio64.exe"), "");
  if (option.build !== undefined) {
    writeFileSync(join(home, "product-info.json"), JSON.stringify({
      name: "Android Studio",
      version: `AI-${option.build}`,
      buildNumber: option.build,
      dataDirectoryName: "AndroidStudio2025.1.4",
    }));
  }
  return home;
}

{
  const cases = [
    { name: "系统级安装器默认路径", home: placeLayout(["Program Files", "Android", "Android Studio"], { build: "251.1" }), parts: ["Program Files", "Android"], depth: 0 },
    { name: "非系统盘 Program Files", home: join(MATRIX, "Program Files", "Android", "Android Studio"), parts: ["Program Files"], depth: 1 },
    { name: "用户级安装器默认路径", home: placeLayout(["Programs", "Android Studio"], { build: "251.2" }), parts: ["Programs"], depth: 0 },
    { name: "容器目录按版本分装", home: placeLayout(["Android Studio", "2025.1.4"], { build: "251.3" }), parts: [], depth: 2 },
    { name: "Toolbox（apps/AndroidStudio/ch-0/<build>）", home: placeLayout(["JetBrains", "Toolbox", "apps", "AndroidStudio", "ch-0", "251.4"], { build: "251.4" }), parts: ["JetBrains", "Toolbox", "apps"], depth: 2 },
    { name: "Chocolatey（lib/androidstudio/tools/android-studio）", home: placeLayout(["chocolatey", "lib", "androidstudio", "tools", "android-studio"], { build: "251.5" }), parts: ["chocolatey", "lib"], depth: 2 },
    { name: "Scoop（apps/androidstudio/current）", home: placeLayout(["scoop", "apps", "androidstudio", "current"], { build: "251.6" }), parts: ["scoop", "apps"], depth: 2 },
    { name: "旧版：无 product-info 且只有 studio.exe", home: placeLayout(["Android Studio", "3.5.2"], { exe: "studio.exe" }), parts: [], depth: 2 },
  ];
  for (const item of cases) {
    const found = collectInstallRoots(join(MATRIX, ...item.parts), item.depth, new Set());
    assert.ok(found.has(item.home), `${item.name}: install root detected`);
  }
  const ignored = placeLayout(["Tools", "IDE"], { build: "1" });
  const scanned = collectInstallRoots(MATRIX, 2, new Set());
  assert.ok(!scanned.has(ignored), "a directory whose name does not look like Studio is ignored");
}

// ---- 线索值 → 安装根（注册表 DisplayIcon / UninstallString / .home 的解析） ----

{
  const home = placeLayout(["hints", "2025.1.1"], { build: "251.8" });
  assert.equal(deriveInstallRoot(home), home, "a plain directory is its own root");
  assert.equal(deriveInstallRoot(join(home, "bin", "studio64.exe")), home, "an exe inside bin resolves two levels up");
  assert.equal(deriveInstallRoot(join(home, "uninstall.exe")), home, "an exe at the root resolves one level up");
  assert.equal(deriveInstallRoot(`"${join(home, "bin", "studio.exe")}",0`), home, "a quoted icon value with an icon index resolves");
  assert.equal(deriveInstallRoot(`"${join(home, "uninstall.exe")}" /S`), home, "a quoted uninstall command with a switch resolves");
  assert.equal(deriveInstallRoot(""), null, "an empty value yields null");
  assert.equal(deriveInstallRoot("Z:\\definitely\\missing\\uninstall.exe"), null, "an unrelated path yields null");
}

// ---- .home 提示通道（各版本系统目录里记录的安装根） ----

{
  const home = placeLayout(["hinted", "2025.1.4"], { build: "251.9" });
  const google = join(TMP_ROOT, "fake-google");
  mkdirSync(join(google, "AndroidStudio2025.1.4"), { recursive: true });
  writeFileSync(join(google, "AndroidStudio2025.1.4", ".home"), `${home}\n`);
  // 陈旧记录（IDE 已卸载）与无关目录都不该产生条目。
  mkdirSync(join(google, "AndroidStudio2024.1"), { recursive: true });
  writeFileSync(join(google, "AndroidStudio2024.1", ".home"), "Z:\\definitely\\missing\\Android Studio\n");
  mkdirSync(join(google, "Chrome"), { recursive: true });

  const found = collectHomeHints([google], new Set());
  assert.equal(found.size, 1, "only a live hint resolves to an install root");
  assert.ok(found.has(home), "the hinted install root is collected");
}

// ---- 假宿主环境 ----

/**
 * 假宿主：可注入底座状态存储的替身。
 * @param config - 插件 Config。
 * @param options.withBase - 底座是否在场（决定 openInAppState 是否存在）。
 * @param options.failWrite - 让状态写入抛错，覆盖落盘失败分支。
 */
function makeHost(config, options = {}) {
  const routes = new Map();
  const logLines = [];
  const stateStore = new Map();
  const namespaceCalls = [];
  const withBase = options.withBase !== false;
  const stateService = {
    namespace: (owner) => {
      namespaceCalls.push(owner);
      return {
        get: (key) => stateStore.get(key),
        set: (key, value) => {
          if (options.failWrite) throw new Error("state file write failed");
          stateStore.set(key, value);
        },
        delete: (key) => { stateStore.delete(key); },
      };
    },
  };
  const ctx = {
    logger: {
      info: (line) => logLines.push(`info ${line}`),
      warn: (line) => logLines.push(`warn ${line}`),
      debug: () => {},
    },
    effect: (fn) => { const dispose = fn(); return typeof dispose === "function" ? dispose : () => {}; },
    get: (serviceName) => (withBase && serviceName === "openInAppState" ? stateService : undefined),
    webServer: {
      register: (route) => { routes.set(route.path, route); return () => routes.delete(route.path); },
    },
    webRuntime: { trustedHosts: [] },
  };
  apply(ctx, config);
  return { routes, logLines, stateStore, namespaceCalls };
}

// HTTP 层用显式安装根驱动：放在名字不像 Studio 的目录下，与容器扫描互不干扰。
const SINGLE_HOME = makeInstall(join(TMP_ROOT, "standalone"), "2024.1.1.12");
const host = makeHost({ studioHome: SINGLE_HOME });
const routes = host.routes;
assert.ok(routes.has(TARGETS_PATH), "targets route registered");
assert.ok(routes.has(SETTINGS_PATH), "settings route registered");
assert.ok(routes.has(VERSION_PREFIX), "version prefix route registered");
assert.equal(routes.get(VERSION_PREFIX).kind, "prefix", "version route matches by prefix");

// ---- 与「Open In...」底座的注册契约对齐 ----
// 底座按 <route>/available 与 <route>/open 调用贡献方，route 由浏览器半边按版本拼出；
// 两边漂移会静默失效，这里把跨半边的约定钉住。

const clientBundle = readFileSync(new URL("lib/client.js", root), "utf8");
assert.ok(clientBundle.includes(`id: "${pkg.name}"`), "client bundle registers under the package name");
const targetsRoute = /const TARGETS_ROUTE = "([^"]+)"/.exec(clientBundle)?.[1];
assert.ok(targetsRoute !== undefined && targetsRoute.length > 0, "client declares the targets route");
assert.equal(`/${targetsRoute}`, TARGETS_PATH, "client targets route resolves to the host endpoint");
const versionPrefix = /const TARGET_ROUTE_PREFIX = "([^"]+)"/.exec(clientBundle)?.[1];
assert.ok(versionPrefix !== undefined && versionPrefix.length > 0, "client declares the version route prefix");
assert.ok(!versionPrefix.startsWith("/") && !versionPrefix.includes("://"), "client routes are document-relative");
assert.equal(`/${versionPrefix}`, VERSION_PREFIX, "client version prefix resolves to the host prefix");
// 底座硬要求：贡献方不自挂会话头部按钮，外观与菜单交给底座。
// 面板配置区块是另一处槽位：以包名为 key 挂到本 bundle 在插件管理页的详情区块上。
assert.ok(!clientBundle.includes("conversation.session.header.utilities"), "client bundle does not register its own header slot");
const panelSlot = /const BUNDLE_CONFIG_SLOT = "([^"]+)"/.exec(clientBundle)?.[1];
assert.equal(panelSlot, "plugins.bundle.config", "client registers the plugin-manager config slot");
const panelKey = /const BUNDLE_CONFIG_KEY = "([^"]+)"/.exec(clientBundle)?.[1];
assert.equal(panelKey, pkg.name, "the panel key equals the package name (the host matches bundles by it)");
const settingsRoute = /const SETTINGS_ROUTE = "([^"]+)"/.exec(clientBundle)?.[1];
assert.ok(settingsRoute !== undefined && settingsRoute.length > 0, "client declares the settings route");
assert.equal(`/${settingsRoute}`, SETTINGS_PATH, "client settings route resolves to the host endpoint");

// ---- README 的事实性 ----

const readme = readFileSync(new URL("README.md", root), "utf8");
assert.ok(readme.includes("dsh-open-in-app-base"), "README declares the base-plugin prerequisite");
for (const match of readme.matchAll(/\]\(\.\/([^)#?]+)\)/g)) {
  assert.ok(existsSync(new URL(match[1], root)), `README links to an existing file: ${match[1]}`);
}

class FakeRequest extends EventEmitter {
  constructor({ method = "GET", headers = {}, body } = {}) {
    super();
    this.method = method;
    this.headers = headers;
    this.url = "/selftest";
    // 用宏任务派发：handler 里可能先 await 若干次才挂上 body 监听器，
    // 微任务会在监听器就位前跑完（真实 HTTP 的报文到达也是宏任务级别的）。
    if (body !== undefined) {
      setImmediate(() => { this.emit("data", Buffer.from(body)); this.emit("end"); });
    } else {
      setImmediate(() => this.emit("end"));
    }
  }
  destroy() {}
}

function FakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    chunks: [],
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; return this; },
    end(chunk) { if (chunk !== undefined) this.chunks.push(chunk); },
    get body() { return this.chunks.join(""); },
    get json() { try { return JSON.parse(this.body); } catch { return null; } },
  };
}

/** 按 pathname 找路由：exact 命中或前缀命中（复刻宿主 webserver 的匹配语义）。 */
function matchRoute(routeTable, pathname) {
  const exact = routeTable.get(pathname);
  if (exact !== undefined) return exact;
  let best;
  for (const [prefix, route] of routeTable) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue;
    if (best === undefined || prefix.length > best.path.length) best = route;
  }
  return best;
}

async function callOn(target, path, request) {
  const route = matchRoute(target.routes, path);
  assert.ok(route !== undefined, `route exists for ${path}`);
  request.url = path;
  const response = new FakeResponse();
  await route.handler(request, response);
  return response;
}

const call = (path, request) => callOn(host, path, request);

const LOOPBACK = { host: "127.0.0.1:3080" };
const SELF_FILE = fileURLToPath(import.meta.url);
const REAL_DIR = fileURLToPath(root);
const IS_WINDOWS = process.platform === "win32";
const VERSION_PATH = `${VERSION_PREFIX}/2024.1.1.12`;

// ---- 围栏 ----

{
  const res = await call(TARGETS_PATH, new FakeRequest({ headers: { host: "evil.example" } }));
  assert.equal(res.statusCode, 403, "non-loopback host rejected");
}
{
  const res = await call(TARGETS_PATH, new FakeRequest({ headers: { ...LOOPBACK, "sec-fetch-site": "cross-site" } }));
  assert.equal(res.statusCode, 403, "cross-site rejected");
}
{
  const res = await call(TARGETS_PATH, new FakeRequest({ headers: { ...LOOPBACK, origin: "http://attacker.test" } }));
  assert.equal(res.statusCode, 403, "foreign origin rejected");
}

// ---- 版本清单 ----

{
  const res = await call(TARGETS_PATH, new FakeRequest({ headers: { ...LOOPBACK, origin: "http://127.0.0.1:3080" } }));
  assert.equal(res.statusCode, 200, "same-origin allowed");
  assert.equal(res.json.ok, true, "targets payload carries ok");
  assert.ok(Array.isArray(res.json.targets), "targets payload carries an array");
  // 显式配置与真实探测结果是合并的（本机装没装 Studio 都成立），只断言包含关系。
  const configured = res.json.targets.find((target) => target.id === "2024.1.1.12");
  assert.ok(configured !== undefined, "the configured install root is among the targets");
  assert.equal(configured.label, "Android Studio (2024.1.1.12)", "target label carries the version");
  for (const target of res.json.targets) {
    assert.equal(target.home, undefined, "targets payload never leaks any local install path");
  }
}
{
  const res = await call(TARGETS_PATH, new FakeRequest({ method: "POST", headers: LOOPBACK }));
  assert.equal(res.statusCode, 405, "targets requires GET");
  assert.equal(res.headers.allow, "GET", "targets 405 advertises the allowed method");
}

// ---- 多路径配置：显式安装根并入探测结果 ----

{
  const multiA = makeInstall(join(TMP_ROOT, "multi", "a"), "2030.1.1", "301.1");
  const multiB = makeInstall(join(TMP_ROOT, "multi", "b"), "2030.2.1", "301.2");
  const multiHost = makeHost({ studioHome: [multiA, multiB] });
  const res = await callOn(multiHost, TARGETS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(res.statusCode, 200, "the multi-path configuration answers");
  const ids = res.json.targets.map((target) => target.id);
  assert.ok(ids.includes("2030.1.1") && ids.includes("2030.2.1"), "both configured install roots become targets");
}
{
  // 无效配置项要被点名，否则用户拼错了也无从察觉。
  const invalidHost = makeHost({ studioHome: ["Z:\\definitely\\missing\\studio-home"] });
  await callOn(invalidHost, TARGETS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.ok(
    invalidHost.logLines.some((line) => line.includes("is not a valid Android Studio install root")),
    "an invalid configured root is reported in the log",
  );
}

// ---- 面板配置路由（插件管理面板的入口 → 底座状态存储） ----

const panelHost = makeHost({});

{
  const res = await callOn(panelHost, SETTINGS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(res.statusCode, 200, "settings read answers");
  assert.deepEqual(res.json.studioHome, [], "nothing saved yet");
  assert.deepEqual(res.json.configStudioHome, [], "no profile config declared");
  assert.equal(res.json.writable, true, "the base store is writable while the base is present");
  assert.ok(
    panelHost.namespaceCalls.length > 0 && panelHost.namespaceCalls.every((owner) => owner === STATE_OWNER),
    "the store is opened under this package name only",
  );
}

{
  // 先预热探测缓存：保存后必须立即可见，不能等 TTL 过期。
  const before = await callOn(panelHost, TARGETS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.ok(!before.json.targets.some((target) => target.id === "2040.1.1"), "the panel path is not detected before the save");
  const home = makeInstall(join(TMP_ROOT, "panel", "a"), "2040.1.1", "401.1");
  const res = await callOn(panelHost, SETTINGS_PATH, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ studioHome: [` ${home} `, "   "] }),
  }));
  assert.equal(res.statusCode, 200, "settings save answers");
  assert.deepEqual(res.json.studioHome, [home], "entries are trimmed and empty rows dropped");
  assert.deepEqual(panelHost.stateStore.get(STATE_KEY), [home], "the value lands in the base store");
  const read = await callOn(panelHost, SETTINGS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.deepEqual(read.json.studioHome, [home], "the saved value reads back");
  const after = await callOn(panelHost, TARGETS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.ok(after.json.targets.some((target) => target.id === "2040.1.1"), "a saved path joins the next probe without waiting for the TTL");
}

{
  // 清空走 delete：状态存储拒绝 undefined，留个空数组只是噪音。
  const res = await callOn(panelHost, SETTINGS_PATH, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ studioHome: [] }),
  }));
  assert.equal(res.statusCode, 200, "clearing answers");
  assert.equal(panelHost.stateStore.has(STATE_KEY), false, "clearing removes the key instead of storing an empty array");
}

{
  // Config 声明的路径与面板值分开展示，但都参与探测。
  const configHost = makeHost({ studioHome: [SINGLE_HOME] });
  const res = await callOn(configHost, SETTINGS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.deepEqual(res.json.configStudioHome, [SINGLE_HOME], "profile config paths are reported separately");
  assert.deepEqual(res.json.studioHome, [], "the panel value stays independent from the profile config");
}

{
  const cases = [
    ["malformed json", "{not json"],
    ["studioHome is not an array", JSON.stringify({ studioHome: "C:\\Studio" })],
    ["a non-string entry", JSON.stringify({ studioHome: [42] })],
    ["an over-long entry", JSON.stringify({ studioHome: ["x".repeat(600)] })],
    ["too many entries", JSON.stringify({ studioHome: Array.from({ length: 33 }, () => "p") })],
  ];
  for (const [label, body] of cases) {
    const res = await callOn(panelHost, SETTINGS_PATH, new FakeRequest({ method: "POST", headers: LOOPBACK, body }));
    assert.equal(res.statusCode, 400, `settings rejects ${label}`);
  }
}

{
  const res = await callOn(panelHost, SETTINGS_PATH, new FakeRequest({ method: "DELETE", headers: LOOPBACK }));
  assert.equal(res.statusCode, 405, "settings rejects unsupported methods");
  assert.equal(res.headers.allow, "GET, POST", "the 405 advertises the supported methods");
}

{
  const res = await callOn(panelHost, SETTINGS_PATH, new FakeRequest({ headers: { host: "evil.example" } }));
  assert.equal(res.statusCode, 403, "settings sits behind the same trusted-origin fence");
}

{
  // 底座缺席：读取仍作答但只读，写入明确失败，前端据此提示先装底座。
  const bareHost = makeHost({}, { withBase: false });
  const read = await callOn(bareHost, SETTINGS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(read.statusCode, 200, "settings read still answers without the base");
  assert.equal(read.json.writable, false, "without the base the panel stays read-only");
  const write = await callOn(bareHost, SETTINGS_PATH, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ studioHome: ["C:\\Studio"] }),
  }));
  assert.equal(write.statusCode, 503, "saving without the base fails loudly");
  assert.equal(write.json.error, "base-plugin-missing", "the failure code tells the panel what is missing");
}

{
  // 落盘失败必须报错，不能假装保存成功。
  const failingHost = makeHost({}, { failWrite: true });
  const res = await callOn(failingHost, SETTINGS_PATH, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ studioHome: ["C:\\Studio"] }),
  }));
  assert.equal(res.statusCode, 500, "a store write failure surfaces as 500");
  assert.ok(failingHost.logLines.some((line) => line.includes("openInAppState write failed")), "the write failure is logged");
}

// ---- 版本子路由 ----

{
  const res = await call(`${VERSION_PATH}/available`, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(res.statusCode, 200, "available probe answered");
  assert.equal(res.json.ok, true, "the base plugin reads ok");
  assert.equal(res.json.available, true, "the installed version reports available");
}
{
  const res = await call(`${VERSION_PREFIX}/2099.9.9/available`, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(res.statusCode, 200, "unknown version still answers the probe");
  assert.equal(res.json.available, false, "unknown version reports unavailable");
}
{
  const res = await call(`${VERSION_PREFIX}/2099.9.9/open`, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(res.statusCode, 405, "open requires POST");
  assert.equal(res.headers.allow, "POST", "open 405 advertises the allowed method");
}
{
  const res = await call(`${VERSION_PREFIX}/`, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(res.statusCode, 404, "the bare prefix is not a version route");
}
{
  const res = await call(`${VERSION_PATH}/unknown-action`, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(res.statusCode, 404, "unknown action is not a route");
}

// ---- 打开：入参校验（路径校验先于目标存在性，故未知版本也能验） ----

{
  const res = await call(`${VERSION_PATH}/open`, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: "{not json",
  }));
  assert.equal(res.statusCode, 400, "malformed json rejected");
}
{
  const res = await call(`${VERSION_PATH}/open`, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ path: "relative/dir" }),
  }));
  assert.equal(res.statusCode, 400, "relative path rejected");
}
{
  const res = await call(`${VERSION_PATH}/open`, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ path: "Z:\\definitely\\missing\\oia" }),
  }));
  assert.equal(res.statusCode, 400, "missing path rejected");
}
{
  const res = await call(`${VERSION_PATH}/open`, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ path: SELF_FILE }),
  }));
  assert.equal(res.statusCode, 400, "file path rejected (not a directory)");
}
{
  const res = await call(`${VERSION_PREFIX}/2099.9.9/open`, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ path: REAL_DIR }),
  }));
  assert.equal(res.statusCode, 503, "an uninstalled version cannot open anything");
}

// ---- 真实探测通道（只读：注册表查询 + 目录扫描，无副作用） ----
// 本机装没装 Studio 都不影响断言：只要求通道不崩、结构合法、本机路径不外泄。

{
  const probeHost = makeHost({ studioHome: "" });
  const res = await callOn(probeHost, TARGETS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.equal(res.statusCode, 200, "the real probe answers");
  assert.ok(Array.isArray(res.json.targets), "the real probe yields an array");
  const ids = res.json.targets.map((target) => target.id);
  assert.equal(new Set(ids).size, ids.length, "probed ids are unique");
  for (const target of res.json.targets) {
    assert.ok(typeof target.id === "string" && target.id.length > 0, "every probed target has an id");
    assert.ok(typeof target.label === "string" && target.label.length > 0, "every probed target has a label");
    assert.equal(target.home, undefined, "the real probe never leaks install paths");
  }
  console.log(`real probe: ${ids.length} install(s) detected${ids.length > 0 ? ` (${ids.join(", ")})` : ""}`);

  // TTL 内重复请求必须命中同一份探测结果（不重复打注册表/目录）。
  const again = await callOn(probeHost, TARGETS_PATH, new FakeRequest({ headers: LOOPBACK }));
  assert.deepEqual(again.json.targets, res.json.targets, "the cached probe serves identical results");
}

// ---- 真实启动链路（默认跳过，会拉起本机最新版 IDE） ----
// 走真实探测（而非显式假安装根），否则启动的会是不存在的假 exe。

if (IS_WINDOWS && process.env.OIA_SELFTEST_SPAWN === "1") {
  const spawnHost = makeHost({ studioHome: "" });
  const list = await callOn(spawnHost, TARGETS_PATH, new FakeRequest({ headers: LOOPBACK }));
  const newest = list.json.targets[0];
  assert.ok(newest !== undefined, "a real install is available to launch");
  const res = await callOn(spawnHost, `${VERSION_PREFIX}/${newest.id}/open`, new FakeRequest({
    method: "POST", headers: LOOPBACK, body: JSON.stringify({ path: REAL_DIR }),
  }));
  assert.equal(res.statusCode, 200, `spawn accepted (body: ${res.body})`);
  console.log(`spawn executed via Android Studio ${newest.id}`);
} else {
  console.log("spawn branch skipped (set OIA_SELFTEST_SPAWN=1 to launch the newest installed IDE)");
}

console.log("host-selftest: all assertions passed");
