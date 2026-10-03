// dsh-open-in-androidstudio — 宿主半边：为「Open In...」底座的 Android Studio 目标提供探测与打开。
//
// 按钮与菜单由 dsh-open-in-app-base 渲染。底座按约定调用每个目标自己的同源路由：
//   GET  <route>/available            报告该版本是否仍安装在本机
//   POST <route>/open（body { path }）用该版本打开目录
// 多版本共存：本机同时装有的每个版本各自成为一条目标。浏览器半边先取
// GET /open-in-androidstudio/targets 拿到版本清单，再按 <前缀>/v/<id>/... 逐条注册，
// 版本维度的请求因此都落在 VERSION_PREFIX 之下。
//
// 额外的安装根（自动探测覆盖不到的免安装 / 解压版等）有两个等价来源，都会并入探测结果：
//   ① Config.studioHome —— profile 的 cordis.patch.yml，适合声明式、随仓库版本化；
//   ② 底座托管的持久化状态 openInAppState —— 插件管理面板里的配置入口写入（SETTINGS_PATH）。
// 底座缺席时 ② 读为空、写入被拒（503），面板据此提示先装底座。
//
// 仅 win32 生效；其余平台 available 恒为 false，目标不出现在菜单里。
import { execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import Schema from "@deepseek-ai/schemastery";

import { buildTargets, collectHomeHints, collectInstallRoots, deriveInstallRoot } from "./targets.mjs";

// cordis 服务名，必须与 cordis.patch.yml 的 insert.id 一致。
export const name = "open-in-androidstudio";

// 静态声明依赖：webServer 承载同源路由，webRuntime 提供可信 Host 清单。
// 不用 ctx.inject 惰性回调：回调内注册的路由在部分宿主形态下不生效。
export const inject = ["webServer", "webRuntime"];

// 字段一律不加 volatile：不同 profile 解析到不同的 schemastery 副本，
// web 侧那份没有该 API，加了会加载期抛错。读值统一经 unwrap()。
export const Config = Schema.object({
  studioHome: Schema.union([Schema.string(), Schema.array(Schema.string())])
    .default([])
    .description("额外的 Android Studio 安装根（单个路径或路径列表），用于自动探测覆盖不到的安装（如免安装 / 解压版）；会与探测结果合并去重。留空 = 只用自动探测。插件管理面板里的配置入口写入同一语义的值，两者合并生效。"),
});

const execFileAsync = promisify(execFile);
const IS_WINDOWS = process.platform === "win32";

export const ROUTE_PREFIX = "/open-in-androidstudio";
/** 浏览器半边取版本清单的路径。 */
export const TARGETS_PATH = `${ROUTE_PREFIX}/targets`;
/** 版本维度子路由前缀：<VERSION_PREFIX>/<id>/available|open。 */
export const VERSION_PREFIX = `${ROUTE_PREFIX}/v`;
/** 插件管理面板的配置入口读写路径（GET 读 / POST 覆盖保存）。 */
export const SETTINGS_PATH = `${ROUTE_PREFIX}/settings`;
/** 底座状态存储里的命名空间：底座按 owner 隔离，必须等于本插件包名。 */
export const STATE_OWNER = "dsh-open-in-androidstudio";
/** 面板配置在状态存储里的键名。 */
export const STATE_KEY = "studioHome";

const PROBE_TTL_MS = 60_000;
const BODY_LIMIT = 64 * 1024;
// 状态存储单值上限 64 KiB；这里再收一道，避免面板误写入超大列表。
const MAX_HOME_ENTRIES = 32;
const MAX_HOME_LENGTH = 512;
const REGISTRY_TIMEOUT_MS = 3000;
// 只沿"像 Studio"的目录下探有限层：Toolbox 布局为 apps/AndroidStudio/ch-0/<build>/，需要两层。
const SCAN_DEPTH = 2;

// 各版本的安装器各写一条卸载项；官方安装器不保证 InstallLocation 非空（实测为空）。
const UNINSTALL_KEYS = [
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];
// App Paths 只登记最后一次安装的版本，作兜底；旧安装可能只登记 studio.exe。
const APP_PATHS_HIVES = [
  "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths",
];
const APP_PATHS_EXES = ["studio64.exe", "studio.exe"];

/** 解包 volatile 配置引用；直接给值时原样返回，两种形态都能读。 */
function unwrap(value) {
  if (value === null || typeof value !== "object") return value;
  if (typeof value.get === "function" && !Array.isArray(value)) return unwrap(value.get());
  return value;
}

/**
 * 归一化「额外安装根」取值：接受单个路径或路径列表，丢弃空项。
 * 同时用于 Config（元素可能是 schemastery 的引用形态）与状态存储读回的值。
 */
function explicitHomes(value) {
  const raw = unwrap(value);
  const list = Array.isArray(raw) ? raw : [raw];
  const homes = [];
  for (const entry of list) {
    const text = String(unwrap(entry) ?? "").trim();
    if (text.length > 0) homes.push(text);
  }
  return homes;
}

/**
 * 校验面板提交的路径列表。
 * @param value - 请求体里的 studioHome 字段。
 * @returns 合法时为去空项后的列表，否则给出可直接回给前端的错误文案。
 */
function validateHomes(value) {
  if (!Array.isArray(value)) return { error: "studioHome must be an array of paths" };
  if (value.length > MAX_HOME_ENTRIES) return { error: `studioHome accepts at most ${MAX_HOME_ENTRIES} entries` };
  const homes = [];
  for (const entry of value) {
    if (typeof entry !== "string") return { error: "every studioHome entry must be a string" };
    const text = entry.trim();
    if (text.length === 0) continue;
    if (text.length > MAX_HOME_LENGTH) return { error: `a studioHome entry exceeds ${MAX_HOME_LENGTH} characters` };
    homes.push(text);
  }
  return { homes };
}

/** 路径等价比较：忽略尾分隔符与大小写（Windows 路径不区分大小写）。 */
function samePath(left, right) {
  const normalize = (text) => String(text ?? "").trim().replace(/[\\/]+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}

// ---- 安装探测 ----

/** 注册表卸载项：每个版本一条，从 InstallLocation / DisplayIcon / UninstallString 里取安装根。 */
async function fromRegistryUninstall(found) {
  for (const key of UNINSTALL_KEYS) {
    try {
      const { stdout } = await execFileAsync(
        "reg.exe",
        ["query", key, "/s", "/f", "Android Studio", "/d"],
        { windowsHide: true, timeout: REGISTRY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      // InstallLocation 实测可能为空，路径反而出现在 DisplayIcon / UninstallString 里，
      // 故几项一并抓出，再回溯到安装根。
      const pattern = /^\s*(?:InstallLocation|InstallDir|DisplayIcon|UninstallString)\s+REG_\w+\s+(.+?)\s*$/gim;
      for (const match of String(stdout).matchAll(pattern)) {
        const root = deriveInstallRoot(match[1]);
        if (root !== null) found.add(root);
      }
    } catch {
      // 键不存在或无匹配都只意味着"这条路没查到"，继续下一条通道。
    }
  }
  return found;
}

/** 注册表 App Paths：从登记的 exe 路径回溯安装根。 */
async function fromRegistryAppPaths(found) {
  for (const hive of APP_PATHS_HIVES) {
    for (const exe of APP_PATHS_EXES) {
      try {
        const { stdout } = await execFileAsync(
          "reg.exe",
          ["query", `${hive}\\${exe}`, "/ve"],
          { windowsHide: true, timeout: REGISTRY_TIMEOUT_MS },
        );
        const matched = /REG_SZ\s+(.+?\.exe)\s*$/im.exec(String(stdout));
        if (matched === null) continue;
        const root = deriveInstallRoot(matched[1]);
        if (root !== null) found.add(root);
      } catch {
        // 同上：没有这条登记就换下一条通道。
      }
    }
  }
  return found;
}

/** 常见安装器与包管理器的父目录；扫描时只沿名字像 Studio 的目录下探。 */
function scanRoots() {
  const env = process.env;
  const roots = [];
  const push = (base, ...sub) => { if (base) roots.push(join(base, ...sub)); };
  push(env.ProgramFiles, "Android");                      // 系统级安装器的默认父目录
  push(env["ProgramFiles(x86)"], "Android");
  push(env.LOCALAPPDATA, "Programs");                     // 用户级安装器的默认父目录
  push(env.LOCALAPPDATA, "Android");
  push(env.LOCALAPPDATA, "Google");
  push(env.LOCALAPPDATA, "JetBrains", "Toolbox", "apps"); // JetBrains Toolbox
  push(env.ProgramData, "chocolatey", "lib");             // Chocolatey
  push(env.USERPROFILE, "scoop", "apps");                 // Scoop
  return roots;
}

/** 各版本系统目录里的 .home 记录安装根（JetBrains 惯例），覆盖自定义路径的安装。 */
function scanHomeHints(found) {
  const env = process.env;
  const bases = [];
  if (env.LOCALAPPDATA) bases.push(join(env.LOCALAPPDATA, "Google"));
  if (env.APPDATA) bases.push(join(env.APPDATA, "Google"));
  return collectHomeHints(bases, found);
}

// 各盘符的常见安装位置：盘符根（可能整盘都是容器布局）、<盘符>:\Android、
// <盘符>:\Program Files[ (x86)] 及其 \Android（IDE 允许装在非系统盘）。
const DRIVE_SUBPATHS = [
  { parts: [], depth: SCAN_DEPTH },
  { parts: ["Android"], depth: 1 },
  { parts: ["Program Files"], depth: 1 },
  { parts: ["Program Files (x86)"], depth: 1 },
  { parts: ["Program Files", "Android"], depth: 1 },
  { parts: ["Program Files (x86)", "Android"], depth: 1 },
];

function scanDrives(found) {
  for (let code = 65; code <= 90; code += 1) {
    const drive = String.fromCharCode(code) + ":\\";
    if (!existsSync(drive)) continue;
    for (const { parts, depth } of DRIVE_SUBPATHS) {
      collectInstallRoots(join(drive, ...parts), depth, found);
    }
  }
  return found;
}

/** 汇总本机安装：显式配置的安装根 + 注册表 + .home 提示 + 目录扫描，合并去重。 */
async function probeInstalls(explicitHomes) {
  if (!IS_WINDOWS) return buildTargets(explicitHomes);
  const found = new Set(explicitHomes);
  await fromRegistryUninstall(found);
  await fromRegistryAppPaths(found);
  scanHomeHints(found);
  for (const root of scanRoots()) collectInstallRoots(root, SCAN_DEPTH, found);
  scanDrives(found);
  return buildTargets(found);
}

// ---- 同源与可信来源围栏 ----
// 路由开在本机 HTTP 面上：必须拒绝跨站与不可信 Host 发起的请求，
// 否则任意本机页面都能借道拉起本机进程。

function headerValue(headers, name) {
  const value = headers?.[name];
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : undefined;
  return typeof value === "string" ? value : undefined;
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127"
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 可信条目未带端口时只比主机名，带端口时比完整 authority。 */
function authorityMatches(hostUrl, entry) {
  const raw = String(entry).trim();
  if (raw.length === 0) return false;
  let entryUrl;
  try {
    entryUrl = new URL(`http://${raw}`);
  } catch {
    return false;
  }
  return /:\d+$/.test(raw) ? entryUrl.host === hostUrl.host : entryUrl.hostname === hostUrl.hostname;
}

function isTrustedRequest(request, trustedHosts) {
  const host = headerValue(request?.headers, "host");
  if (typeof host !== "string" || host.length === 0) return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  const trusted = Array.isArray(trustedHosts) ? trustedHosts : [];
  if (!isLoopbackHostname(hostUrl.hostname) && !trusted.some((entry) => authorityMatches(hostUrl, entry))) {
    return false;
  }
  if (headerValue(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = headerValue(request.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        rejectBody(new Error("request body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) { resolveBody({}); return; }
      try { resolveBody(JSON.parse(text)); } catch (error) { rejectBody(error); }
    });
    request.on("error", rejectBody);
  });
}

// ---- 插件主体 ----

/**
 * 打开一次插件实例。路由与探测缓存都由本闭包持有，fiber 卸载即失效。
 * @param {object} ctx - cordis 上下文（宿主侧）。
 * @param {object} config - 已校验的 Config 实例（字段可能是引用形态）。
 */
export function apply(ctx, config) {
  const logger = ctx.logger;
  let probe = { at: 0, targets: [] };

  /**
   * 底座托管的状态命名空间；底座缺席（未安装或尚未激活）时返回 undefined。
   * 每次调用都现取服务：底座可能晚于本插件装配，不能在 apply 时把结果缓存下来。
   */
  function stateNamespace() {
    const service = typeof ctx.get === "function" ? ctx.get("openInAppState") : undefined;
    if (service === null || service === undefined || typeof service.namespace !== "function") return undefined;
    try {
      return service.namespace(STATE_OWNER);
    } catch (error) {
      logger.warn(`openInAppState namespace unavailable: ${String(error?.message ?? error)}`);
      return undefined;
    }
  }

  /** 面板里保存的额外安装根；读失败或底座缺席一律按空列表处理（配置坏了不该拖垮探测）。 */
  function savedHomes() {
    const state = stateNamespace();
    if (state === undefined) return [];
    try {
      return explicitHomes(state.get(STATE_KEY));
    } catch (error) {
      logger.warn(`openInAppState read failed: ${String(error?.message ?? error)}`);
      return [];
    }
  }

  /** 探测结果按 TTL 缓存：额外安装根（Config + 面板状态）+ 自动探测（注册表 / .home / 目录扫描）的合并结果。 */
  async function resolveTargets() {
    const now = Date.now();
    if (now - probe.at < PROBE_TTL_MS) return probe.targets;
    const homes = [...explicitHomes(config?.studioHome), ...savedHomes()];
    const targets = await probeInstalls(homes);
    // 显式配置若拼错或指向非安装根，不会出现在目标里；给出提示便于排查。
    for (const home of homes) {
      if (!targets.some((target) => samePath(target.home, home))) {
        logger.warn(`studioHome entry is not a valid Android Studio install root: ${home}`);
      }
    }
    probe = { at: now, targets };
    return probe.targets;
  }

  /** spawn 一个 detached 子进程，确认成功启动（'spawn' 事件）后兑现。 */
  function spawnDetached(file, args) {
    return new Promise((resolveSpawn, rejectSpawn) => {
      let child;
      try {
        // Android Studio 的启动器（JetBrains Runtime）不读 ELECTRON_* 变量，环境直接继承。
        child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
      } catch (error) {
        rejectSpawn(error);
        return;
      }
      child.once("error", rejectSpawn);
      child.once("spawn", () => {
        child.unref();
        resolveSpawn();
      });
    });
  }

  function trusted(request, response) {
    if (isTrustedRequest(request, ctx.webRuntime?.trustedHosts ?? [])) return true;
    logger.warn(`rejected untrusted request: ${String(request?.url ?? "")}`);
    sendJson(response, 403, { ok: false, error: "forbidden" });
    return false;
  }

  function methodNotAllowed(response, allow) {
    response.writeHead(405, { allow });
    response.end();
  }

  /** 版本清单：浏览器半边据此逐条注册菜单目标。 */
  async function handleTargets(request, response) {
    if (!trusted(request, response)) return;
    if (request.method !== "GET") {
      methodNotAllowed(response, "GET");
      return;
    }
    try {
      const targets = await resolveTargets();
      sendJson(response, 200, {
        ok: true,
        targets: targets.map(({ id, label }) => ({ id, label })),
      });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  /**
   * 面板配置入口：GET 读当前值（含 Config 里声明的、不可在面板编辑的那部分），
   * POST 覆盖保存到状态存储；底座缺席时 POST 返回 503，前端据此提示先装底座。
   */
  async function handleSettings(request, response) {
    if (!trusted(request, response)) return;
    const state = stateNamespace();
    if (request.method === "GET") {
      sendJson(response, 200, {
        ok: true,
        studioHome: savedHomes(),
        configStudioHome: explicitHomes(config?.studioHome),
        writable: state !== undefined,
      });
      return;
    }
    if (request.method !== "POST") {
      methodNotAllowed(response, "GET, POST");
      return;
    }
    if (state === undefined) {
      // 不静默丢弃用户输入：底座缺席是明确的失败，而非"保存成功但没生效"。
      sendJson(response, 503, { ok: false, error: "base-plugin-missing" });
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `malformed body: ${String(error?.message ?? error)}` });
      return;
    }
    const checked = validateHomes(body?.studioHome);
    if (checked.error !== undefined) {
      sendJson(response, 400, { ok: false, error: checked.error });
      return;
    }
    try {
      // 清空用 delete：状态存储拒绝 undefined，留一个空数组只是噪音。
      if (checked.homes.length === 0) state.delete(STATE_KEY);
      else state.set(STATE_KEY, checked.homes);
    } catch (error) {
      logger.warn(`openInAppState write failed: ${String(error?.message ?? error)}`);
      sendJson(response, 500, { ok: false, error: `save-failed: ${String(error?.message ?? error)}` });
      return;
    }
    // 新配置立即参与下次探测，不必等 TTL 过期。
    probe = { at: 0, targets: [] };
    logger.info(`studioHome updated from the plugin panel: ${checked.homes.length} explicit entry(ies)`);
    sendJson(response, 200, { ok: true, studioHome: checked.homes });
  }

  /** 从 <VERSION_PREFIX>/<id>/<action> 路径里取出版本 id 与动作；形状不符返回 null。 */
  function parseVersionPath(pathname) {
    if (!pathname.startsWith(`${VERSION_PREFIX}/`)) return null;
    const rest = pathname.slice(VERSION_PREFIX.length + 1);
    const slash = rest.indexOf("/");
    if (slash <= 0 || slash === rest.length - 1) return null;
    try {
      return { id: decodeURIComponent(rest.slice(0, slash)), action: rest.slice(slash + 1) };
    } catch {
      return null;
    }
  }

  async function handleOpen(request, response, target) {
    let dir;
    try {
      const body = await readJsonBody(request);
      dir = typeof body?.path === "string" ? body.path.trim() : "";
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `malformed body: ${String(error?.message ?? error)}` });
      return;
    }
    if (!/^[a-zA-Z]:[\\/]/.test(dir) && !dir.startsWith("\\\\")) {
      sendJson(response, 400, { ok: false, error: "path must be an absolute local directory" });
      return;
    }
    let statResult = null;
    try {
      statResult = statSync(dir);
    } catch {
      sendJson(response, 400, { ok: false, error: "path does not exist" });
      return;
    }
    if (!statResult.isDirectory()) {
      sendJson(response, 400, { ok: false, error: "path is not a directory" });
      return;
    }
    if (target === undefined) {
      sendJson(response, 503, { ok: false, error: "studio-not-installed" });
      return;
    }
    try {
      await spawnDetached(target.exe, [dir]);
      logger.info(`opened workspace with Android Studio ${target.version || target.id}: ${dir}`);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      logger.warn(`spawn failed: ${String(error?.message ?? error)}`);
      sendJson(response, 500, { ok: false, error: `spawn-failed: ${String(error?.message ?? error)}` });
    }
  }

  /** 版本维度路由：<VERSION_PREFIX>/<id>/available|open。 */
  async function handleVersionRoute(request, response) {
    if (!trusted(request, response)) return;
    let parsed = null;
    try {
      parsed = parseVersionPath(new URL(String(request.url ?? "/"), "http://localhost").pathname);
    } catch {
      parsed = null;
    }
    if (parsed === null) {
      sendJson(response, 404, { ok: false, error: "not-found" });
      return;
    }
    const targets = await resolveTargets();
    const target = targets.find((entry) => entry.id === parsed.id);
    if (parsed.action === "available") {
      if (request.method !== "GET") {
        methodNotAllowed(response, "GET");
        return;
      }
      sendJson(response, 200, { ok: true, available: target !== undefined });
      return;
    }
    if (parsed.action === "open") {
      if (request.method !== "POST") {
        methodNotAllowed(response, "POST");
        return;
      }
      await handleOpen(request, response, target);
      return;
    }
    sendJson(response, 404, { ok: false, error: "not-found" });
  }

  const routes = [
    { kind: "exact", path: TARGETS_PATH, handler: handleTargets },
    { kind: "exact", path: SETTINGS_PATH, handler: handleSettings },
    { kind: "prefix", path: VERSION_PREFIX, handler: handleVersionRoute },
  ];

  ctx.effect(() => {
    const disposers = [];
    for (const route of routes) {
      try {
        disposers.push(ctx.webServer.register(route));
      } catch (error) {
        logger.warn(`route ${route.path} was not registered: ${String(error)}`);
      }
    }
    logger.info(`${ROUTE_PREFIX} routes registered (${disposers.length}/${routes.length})`);
    return () => { for (const dispose of disposers) dispose(); };
  }, "open-in-androidstudio: routes");

  if (!IS_WINDOWS) {
    logger.info("non-Windows platform: menu target stays hidden (Android Studio detection is Windows-only)");
  }
  void resolveTargets().then((targets) => {
    const found = targets.length === 0 ? "not found" : `${targets.length} install(s): ${targets.map((t) => t.id).join(", ")}`;
    logger.info(`androidstudio probe: ${found}`);
  }).catch((error) => logger.warn(`androidstudio probe failed: ${String(error)}`));
}
