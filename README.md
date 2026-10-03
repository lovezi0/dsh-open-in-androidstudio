# dsh-open-in-androidstudio

[DeepSeek Harness](https://www.deepseek.com/harness)（DSH）第三方插件：向会话（Session）头部工具栏的 **"Open In..."** 按钮组注册 **Android Studio** 目标，一键用本机 [Android Studio](https://developer.android.com/studio) 打开当前会话的 workspace 目录。

按钮与菜单由底座 `dsh-open-in-app-base` 统一渲染，本插件只负责「目标软件」这一半：注册目标记录，并在自己的宿主半边实现「是否可用」与「怎么打开」。不 fork、不修改宿主。本机共存多个 Android Studio 版本时，每个版本各占一条菜单项（按版本新→旧排列，最新版是菜单默认项），点哪条就用哪个版本打开。

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE) [![DeepSeek Harness:0.2.0-rc.2](https://img.shields.io/badge/DeepSeek%20Harness-0.2.0--rc.2-success.svg?labelColor=4D6BFE)](https://github.com/deepseek-ai/deepseek-harness) [![Desktop: supported](https://img.shields.io/badge/Desktop-supported-success.svg?labelColor=4D6BFE)](#安装)

## 特性

- **多版本共存**：探测本机全部 Android Studio 安装，每个版本一条菜单项——同时装有正式版与预览版时可直接选版本打开，最新版排在前面作默认项。
- **双端一致**：web profile 与 Desktop（Electron）profile 同一条通道、同一份代码。
- **接入原生位置**：目标并入会话头部的「Open In...」按钮组；按钮尺寸、图标规格与菜单由底座渲染，本插件不自绘控件。
- **自动探测安装位置**：按「显式配置 → 注册表卸载项与 App Paths → 各版本系统目录的 `.home` 记录 → 常见安装目录扫描」汇总本机全部安装——系统级与用户级默认路径、非系统盘、容器布局（`<盘符>:\Android Studio\<版本>\`）、Toolbox / Chocolatey / Scoop 等布局都能识别；探测不到时该目标不进入菜单（远程/SSH 场景天然隐身），也可用配置显式指定。
- **面板内配置**：自动探测覆盖不到的安装（免安装 / 解压版、非标准位置）可在插件管理面板里补安装根——值由底座托管的状态存储持久化（跨 profile 共享），也能继续写在 profile 配置里，两者合并生效。
- **安全围栏**：路由仅接受回环/可信 Host 的同源请求，拒绝跨站；目标目录必须是本机绝对路径且真实存在；版本清单不下发本机安装路径。
- **仅 Windows 生效**：非 Windows 平台该目标恒不可用。

## 安装

前置依赖：底座 `dsh-open-in-app-base`（会话头部的「Open In...」按钮组；面板里的配置入口依赖它 0.2.0 起提供的 `openInAppState` 状态存储）。本插件**不携带底座**，装本插件前先装它：

```bash
dsh plugin --profile web add dsh-open-in-app-base
dsh plugin --profile desktop add dsh-open-in-app-base
```

底座缺席时本插件不会报错，只是菜单里不出现任何目标（静默等待底座就绪）。

本项目**暂不发布 npm 包**，从源码安装，按场景选通道。

**本机安装**（路径可直接访问，无需先打包）：

```bash
# 在仓库的父目录执行，路径指向本仓库
dsh plugin --profile web add file:./dsh-open-in-androidstudio
dsh plugin --profile desktop add file:./dsh-open-in-androidstudio
```
**从 git 仓库安装**（仓库已托管；源码自带 `lib/`，零构建、零构建授权）：

```bash
dsh plugin --profile web add 'github:lovezi0/dsh-open-in-androidstudio#vX.Y.Z'
```

**开发调试**（改完立即生效，pnpm 记为 `link:`）：

```bash
dsh plugin --profile web add .   # 在仓库内执行
```

装载后确认层已就位：`dsh --profile web --dump-config`（应出现 `# == dsh-open-in-androidstudio`）。

## 配置

额外的 Android Studio 安装根（自动探测覆盖不到的免安装 / 解压版、非标准位置）有两个等价来源，都会并入自动探测结果，不会取代它：

**插件管理面板**（推荐）：侧边栏「插件」→ 本插件 → 详情页里的「额外的 Android Studio 安装路径」区块，逐行填写后保存。值由底座托管、跨 profile 共享，重启后仍在；区块里同时显示 profile 配置声明的条数。该入口需要底座 0.2.0 及以上，底座缺席时区块只读并说明原因。

**profile 的 `cordis.patch.yml`**（适合随配置一起版本化 / 批量分发）：按 id 覆盖即可，无需改插件代码：

```yaml
- id: open-in-androidstudio
  config:
    # 单个路径或路径列表。
    studioHome:
      - C:\Tools\AndroidStudio
      - C:\Portable\Android Studio
```

留空则只用自动探测。任一来源里的路径若不是有效安装根（拼错、目录已移动），宿主日志会给出警告。

## 工作原理（简述）

插件向底座注册目标：先取本机版本清单（`GET open-in-androidstudio/targets`），再为每个版本注册一条目标；底座按约定向每条目标自己的路由探测可用性（`GET open-in-androidstudio/v/<版本>/available`），点击后发送当前会话目录（`POST open-in-androidstudio/v/<版本>/open`）。宿主侧校验来源与路径后，以目录参数拉起该版本的启动器。面板里的安装路径配置走 `GET` / `POST open-in-androidstudio/settings`，由宿主半边写进底座托管的状态存储。实现细节见源码注释。

## 开发与分发

- 构建：`npm run build`（纯 Node 脚本，零依赖；产物 `lib/` 随仓库提交，`file:` 与 git 安装通道零构建）。
- 打包分发：`npm pack` 生成 tgz，用 `dsh plugin add ./<包名>-<版本>.tgz` 安装。
- 版本纪律：实质更新同步升 `package.json` 的 `version`（新功能升 minor、纯修复升 patch）；项目暂不发布 npm，版本号用于 tgz 文件名与 git tag 标识。
- 图标：线条化素材在 `assets/androidstudio-line.svg`，浏览器产物内联其路径数据；离线自测会比对两者，素材改动需同步到 `src/client/10-target.js`。
- 离线自测：`npm run selftest`（用假宿主 ctx 驱动 host 路由、用 vm 沙箱驱动 client 产物，覆盖围栏、版本子路由、多版本排序与注册链路、面板配置的读写与底座缺席时的降级，无需装载 DSH）。
- 提交前请自行完成脱敏检查（本机路径、用户名、凭据一律不得入库）。

## 版本历史

- **0.1.0** 
    - 🔥add plugin dsh-open-in-app-androidstudio

## License

[MIT](./LICENSE)
