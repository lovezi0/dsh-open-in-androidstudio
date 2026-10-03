// dsh-open-in-androidstudio — 安装记录的探测与整理。
//
// Android Studio 的安装形态不止一种：官方安装器默认装成 <某目录>\bin\studio64.exe，
// 也常见容器目录下按版本分装的共存布局（如 <某目录>\<版本>\bin\studio64.exe），
// 以及 Toolbox / Chocolatey / Scoop 等包管理器布局。识别标准因此刻意宽松：
// bin 下存在 studio64.exe（旧版为 studio.exe）即算安装根——
// 旧版（3.x）没有 product-info.json，新版 product-info.json 的 version 是平台号
// （AI-251.xxx）而非市场版本号，市场版本号只能从目录名或 dataDirectoryName 推导。
//
// 本模块只做确定性判断与整理，具体的 I/O 线索（环境变量、注册表、盘符）由宿主半边提供。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** 安装根 bin/ 下可能的启动器，按优先级排列（新版只带 studio64.exe）。 */
export const EXE_NAMES = ["studio64.exe", "studio.exe"];
export const PRODUCT_INFO_NAME = "product-info.json";

/** 读安装根的 product-info.json；旧版安装没有该文件，缺失或异常都返回 null。 */
export function readProductInfo(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, PRODUCT_INFO_NAME), "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** 安装根 bin/ 下实际存在的启动器绝对路径；都不存在时返回 null。 */
export function resolveExe(home) {
  if (typeof home !== "string" || home.length === 0) return null;
  for (const name of EXE_NAMES) {
    const candidate = join(home, "bin", name);
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      // 权限等异常按"这条没有"处理。
    }
  }
  return null;
}

/** 判定目录是否为可用的安装根：bin/ 下存在任一启动器即可。 */
export function isInstallRoot(dir) {
  return resolveExe(dir) !== null;
}

/**
 * 目录名是否可能是 Studio 的安装/容器目录：
 * "androidstudio*"（各类安装名与系统目录名），以及单独一个 "android"——
 * 官方安装器的默认父目录就叫 Android（如 Program Files\Android\Android Studio）。
 */
export function looksLikeStudioDir(name) {
  if (typeof name !== "string") return false;
  const normalized = name.toLowerCase().replace(/[\s_-]+/g, "");
  return normalized === "android" || normalized.startsWith("androidstudio");
}

/** 把一段线索值展开成可能的路径串：取引号内路径、截到 .exe 为止、去掉图标索引后缀。 */
function pathCandidates(value) {
  const raw = String(value ?? "").trim();
  if (raw.length === 0) return [];
  const found = [];
  const quoted = /^"([^"]+)"/.exec(raw);
  if (quoted !== null) found.push(quoted[1]);
  const exe = /^(.+?\.exe)\b/i.exec(raw);
  if (exe !== null) found.push(exe[1]);
  found.push(raw.replace(/,\s*\d+\s*$/, "").trim());
  return [...new Set(found.filter((entry) => entry.length > 0))];
}

/**
 * 从一段线索值里解析出安装根。线索可能是目录、exe 路径，或带引号与参数的命令行
 * （注册表的 DisplayIcon / UninstallString 就是后两种）；每个候选形式向上回溯最多两级
 * （bin\studio64.exe → 安装根，根下的 uninstall.exe → 安装根）。
 * @param {string} value - 线索值。
 * @returns {string|null} 安装根绝对路径；无法解析时返回 null。
 */
export function deriveInstallRoot(value) {
  for (const candidate of pathCandidates(value)) {
    let current = candidate;
    for (let depth = 0; depth < 3 && current.length > 0; depth += 1) {
      if (isInstallRoot(current)) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

/** 容器目录下探：只看子目录是不是安装根，不再要求目录名像 Studio（版本号目录名如 "2025.1.4"）。 */
function collectVersionChildren(dir, depth, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    if (isInstallRoot(child)) {
      found.add(child);
      continue;
    }
    if (depth > 0) collectVersionChildren(child, depth - 1, found);
  }
}

/** 在 root 下收集安装根：名字像 Studio 的目录自身，或它下探若干层后的版本子目录。 */
export function collectInstallRoots(root, depth, found) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !looksLikeStudioDir(entry.name)) continue;
    const dir = join(root, entry.name);
    if (isInstallRoot(dir)) {
      found.add(dir);
      continue;
    }
    if (depth > 0) collectVersionChildren(dir, depth - 1, found);
  }
  return found;
}

/**
 * 读各版本系统目录里的 .home（JetBrains 惯例，首行即安装根），补一条与安装位置无关的线索：
 * 只要该版本被运行过就会留下记录，覆盖装在任意自定义路径的安装。
 */
export function collectHomeHints(googleDirs, found) {
  for (const base of googleDirs) {
    let entries;
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !looksLikeStudioDir(entry.name)) continue;
      let text;
      try {
        text = readFileSync(join(base, entry.name, ".home"), "utf8");
      } catch {
        continue;
      }
      const root = deriveInstallRoot(text.split(/\r?\n/)[0]);
      if (root !== null) found.add(root);
    }
  }
  return found;
}

/** 纯市场版本号的目录名（如 "2025.1.1"、"3.5.2"）。 */
function isMarketVersion(text) {
  return /^\d+(\.\d+)+$/.test(text);
}

/** 版本号 → 数字段数组；非数字段（缺失、异常格式）落到空数组，排序时视为最旧。 */
function versionRank(text) {
  return String(text ?? "")
    .split(/[^\d]+/)
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
}

/** 版本新者在前；版本相同（或都缺失）时按安装路径稳定排序。 */
function compareInstalls(left, right) {
  const a = versionRank(left.display);
  const b = versionRank(right.display);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (b[index] ?? -1) - (a[index] ?? -1);
    if (diff !== 0) return diff;
  }
  return left.home.localeCompare(right.home);
}

/** URL 与菜单标识用的 slug；输入无可用字符时退回 fallback。 */
function slugify(text, fallback) {
  const slug = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : fallback;
}

/** 安装根 → 展示用记录：优先市场版本号（目录名 / dataDirectoryName），再退目录名与 build 号。 */
function toInstall(dir) {
  const info = readProductInfo(dir);
  const directory = basename(dir).replace(/\s+/g, " ").trim();
  const dataName = typeof info?.dataDirectoryName === "string" ? info.dataDirectoryName.trim() : "";
  const fromData = dataName.replace(/^AndroidStudio[\s_-]*/i, "").trim();
  const build = typeof info?.buildNumber === "string" ? info.buildNumber.trim() : "";
  const platform = typeof info?.version === "string" ? info.version.trim() : "";
  const display = (isMarketVersion(directory) && directory)
    || (isMarketVersion(fromData) && fromData)
    || directory
    || build
    || platform;
  return { home: dir, exe: resolveExe(dir), display };
}

/**
 * 把候选安装根整理成菜单目标列表。
 * @param {Iterable<string>} dirs - 候选安装根（可能含无效项与重复项）。
 * @returns {{ id: string, label: string, home: string, exe: string, version: string }[]} 新版本在前，id 唯一。
 */
export function buildTargets(dirs) {
  // 尾分隔符与大小写差异（Windows 路径不区分大小写）会让多来源探测撞出重复项，先归一化去重。
  const unique = new Map();
  for (const dir of dirs) {
    if (typeof dir !== "string") continue;
    const trimmed = dir.trim().replace(/[\\/]+$/, "");
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (!unique.has(key)) unique.set(key, trimmed);
  }
  const installs = [...unique.values()]
    .filter((dir) => isInstallRoot(dir))
    .map(toInstall)
    .sort(compareInstalls);
  const used = new Set();
  return installs.map((install) => {
    const base = slugify(install.display, "studio");
    let id = base;
    for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
    used.add(id);
    return {
      id,
      label: `Android Studio (${install.display})`,
      home: install.home,
      exe: install.exe,
      version: install.display,
    };
  });
}
