// 浏览器 bundle 片段：本文件与 10-target.js、20-settings.js、90-tail.js 同处一个工厂闭包，
// 由 scripts/build.mjs 按序拼接为 lib/client.js，单独看不是完整模块。
window.__ModuleLoader__.load({
  id: "dsh-open-in-androidstudio",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    // 菜单与按钮由底座渲染；这里取平台单例只为插件管理面板里的配置区块自绘控件
    // （浏览器模块系统不支持插件相对 require，只能取冻结模块表里的这几项）。
    var React = require("react");
    var primitives = require("@deepseek-ai/dsh-client-ui-primitives");


    // 目标记录由宿主探测结果逐条生成：外观（图标尺寸/描边/颜色、按钮结构与菜单）由底座统一决定，
    // 这里只声明目标身份与自己的路由前缀。
    // route 用文档相对路径（去前导斜杠）：web 与 Desktop 的 dsh-app:// 协议下才同源可达。
    const TARGETS_ROUTE = "open-in-androidstudio/targets";
    const TARGET_ROUTE_PREFIX = "open-in-androidstudio/v";

    // 24×24 描边路径数据（Android 机器人头部 + 双天线 + 双眼的线条化形象）；与
    // assets/androidstudio-line.svg 逐条对应，由 client 自测比对，防止内联数据与素材漂移。
    const ICON = [
      "M6 16.5V13a6 6 0 0 1 12 0v3.5z",
      "M8.5 4.5 10 8",
      "M15.5 4.5 14 8",
      "M9.75 11.5v.01",
      "M14.25 11.5v.01",
    ];

    /** 取宿主探测到的版本清单；读取失败一律降级为空清单（菜单里不出现本插件）。 */
    function fetchTargets(fetchImpl) {
      return fetchImpl(TARGETS_ROUTE, { headers: { accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => (Array.isArray(payload?.targets) ? payload.targets : []))
        .catch(() => []);
    }

    /** 宿主条目 → 底座目标记录；缺 id/label 的条目丢弃，不让坏数据进菜单。 */
    function toTarget(entry, index) {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      if (id.length === 0 || label.length === 0) return null;
      return {
        // id 加插件命名空间：与其它贡献者的目标同处一张注册表，避免相撞。
        id: "androidstudio-" + id,
        label: label,
        route: TARGET_ROUTE_PREFIX + "/" + id,
        icon: ICON,
        // 宿主已按版本新→旧排序，order 沿用序号：新版是菜单默认项。
        order: index,
      };
    }


    // 插件管理面板（Plugin Manager）里本包详情页的配置入口：槽位 plugins.bundle.config，
    // 以本包名为 key —— 宿主按 key 把区块挂到对应 bundle 的详情页上。
    // 值不进宿主 config：写入经本插件 host 路由落到底座托管的 openInAppState，跨重启保留。

    const SETTINGS_ROUTE = "open-in-androidstudio/settings";
    const BUNDLE_CONFIG_SLOT = "plugins.bundle.config";
    // 必须等于 npm 包名（宿主按包名匹配详情页），离线自测钉住这一约束。
    const BUNDLE_CONFIG_KEY = "dsh-open-in-androidstudio";

    const h = React.createElement;
    const Button = primitives.Button;
    const Input = primitives.Input;

    /** 读取当前配置；失败或底座缺席时返回 null（界面据此显示不可用）。 */
    function fetchSettings() {
      return fetch(SETTINGS_ROUTE, { headers: { accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : null))
        .then((payload) => {
          if (payload === null || payload.ok !== true) return null;
          return {
            studioHome: Array.isArray(payload.studioHome)
              ? payload.studioHome.filter((entry) => typeof entry === "string")
              : [],
            configStudioHome: Array.isArray(payload.configStudioHome) ? payload.configStudioHome : [],
            writable: payload.writable === true,
          };
        })
        .catch(() => null);
    }

    /** 服务端错误 → 界面文案：已知失败各有明确处置，其余保留原始信息便于排查。 */
    function saveErrorMessage(status, reason) {
      if (status === 503 || reason === "base-plugin-missing") {
        return "保存失败：需要先安装 dsh-open-in-app-base（底座）。";
      }
      if (status === 400) return "保存失败：路径列表不合法（每一项都要是路径文本）。";
      return `保存失败：${typeof reason === "string" && reason.length > 0 ? reason : `宿主返回 ${status}`}`;
    }

    /** 覆盖保存路径列表；返回统一的 { ok } / { ok: false, error } 结果。 */
    function saveSettings(homes) {
      return fetch(SETTINGS_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ studioHome: homes }),
      })
        .then(async (response) => {
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          if (response.ok && payload?.ok === true) return { ok: true };
          return { ok: false, error: saveErrorMessage(response.status, payload?.error) };
        })
        .catch(() => ({ ok: false, error: "保存失败：无法连接宿主路由。" }));
    }

    /** 面板区块：编辑额外的 Android Studio 安装根。 */
    function StudioHomeSection() {
      const [state, setState] = React.useState({
        status: "loading",
        rows: [],
        configRows: [],
        writable: false,
        message: "",
      });

      React.useEffect(() => {
        let alive = true;
        fetchSettings().then((payload) => {
          if (!alive) return;
          if (payload === null) {
            setState({ status: "error", rows: [], configRows: [], writable: false, message: "读取配置失败：宿主路由不可用。" });
            return;
          }
          setState({
            status: "ready",
            rows: payload.studioHome,
            configRows: payload.configStudioHome,
            writable: payload.writable,
            message: "",
          });
        });
        return () => { alive = false; };
      }, []);

      const patch = (next) => setState((previous) => Object.assign({}, previous, next));

      const updateRow = (index, value) => {
        const rows = state.rows.slice();
        rows[index] = value;
        patch({ rows, message: "" });
      };
      const addRow = () => patch({ rows: state.rows.concat(""), message: "" });
      const removeRow = (index) => {
        const rows = state.rows.slice();
        rows.splice(index, 1);
        patch({ rows, message: "" });
      };
      const save = () => {
        patch({ status: "saving", message: "保存中…" });
        saveSettings(state.rows).then((result) => {
          if (result.ok) {
            // 与宿主一致地丢弃空行，回显即落盘结果。
            patch({ status: "ready", rows: state.rows.filter((row) => row.trim().length > 0), message: "已保存。" });
          } else {
            patch({ status: "ready", message: result.error });
          }
        });
      };

      const busy = state.status === "loading" || state.status === "saving";
      const children = [
        // 度量对齐宿主详情页的区块标题（14px/500/20px，见 PluginManagerPage.module.css 的 sectionTitle）。
        h("h4", { key: "title", style: { margin: 0, fontSize: "14px", fontWeight: 500, lineHeight: "20px" } }, "额外的 Android Studio 安装路径"),
        h("div", { key: "hint", style: { fontSize: "12px", lineHeight: 1.6, opacity: 0.72 } },
          "自动探测覆盖不到的安装（免安装 / 解压版、非标准位置）在这里补充安装根；与自动探测结果合并去重，不会取代它。每行一个路径。"),
      ];

      state.rows.forEach((row, index) => {
        children.push(h("div", { key: `row-${index}`, style: { display: "flex", alignItems: "center", gap: "8px" } },
          h("div", { style: { flex: "1 1 auto" } },
            h(Input, {
              value: row,
              "aria-label": "Android Studio 安装路径",
              placeholder: "C:\\Program Files\\Android\\Android Studio",
              spellCheck: false,
              disabled: busy || !state.writable,
              style: { width: "100%" },
              onChange: (event) => updateRow(index, event.target.value),
            })),
          h(Button, { size: "sm", disabled: busy || !state.writable, onClick: () => removeRow(index) }, "删除"),
        ));
      });

      children.push(h("div", { key: "actions", style: { display: "flex", alignItems: "center", gap: "8px" } },
        h(Button, { size: "sm", disabled: busy || !state.writable, onClick: addRow }, "添加路径"),
        h(Button, { size: "sm", variant: "primary", disabled: busy || !state.writable, onClick: save }, "保存"),
        state.message.length > 0
          ? h("span", { key: "message", role: "status", style: { fontSize: "12px", opacity: 0.72 } }, state.message)
          : null,
      ));

      if (state.configRows.length > 0) {
        children.push(h("div", { key: "config-note", style: { fontSize: "12px", lineHeight: 1.6, opacity: 0.6 } },
          `profile 配置（cordis.patch.yml）里另有 ${state.configRows.length} 条路径，同样生效；要改它们请改 profile 配置。`));
      }
      if (!state.writable && state.status !== "loading") {
        children.push(h("div", { key: "base-note", style: { fontSize: "12px", lineHeight: 1.6, opacity: 0.6 } },
          "未检测到底座 dsh-open-in-app-base：这里的路径无法保存，请先安装底座。"));
      }

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } }, children);
    }


    // 浏览器 bundle 片段：承接 00-head.js 打开的工厂闭包，由 scripts/build.mjs 拼在末尾。

    /** 装配：把本机每个 Android Studio 版本注册为「Open In...」底座的一条打开目标。 */
    function apply(ctx) {
      // 底座服务作为可选依赖经 ctx.inject 挂子 fiber：底座缺席时子 fiber 保持等待，
      // 顶层条目仍 active，不阻塞宿主启动；底座就绪（含晚于本插件装配）时自动激活。
      ctx.inject(["openInAppTargets"], async (scope) => {
        // 版本清单只有宿主知道，须在子 fiber 内异步取回；子 fiber 不在客户端启动审计范围，
        // 取数失败只表现为本插件静默无目标。
        const entries = await fetchTargets((input, init) => fetch(input, init));
        const targets = entries.map(toTarget).filter((target) => target !== null);
        if (targets.length === 0) return;
        // 一个 effect 管住全部注册；插件卸载时逐条反注册。
        scope.effect(() => {
          const releases = targets.map((target) => scope.openInAppTargets.register(target));
          return () => { for (const release of releases) release(); };
        }, "open-in-androidstudio: open targets");
      });

      // 插件管理面板里的配置入口。同样挂子 fiber：slots 是 web 客户端的基线服务，
      // 但缺席时（非 web 形态）本插件顶层条目仍要保持 active。
      // slots.inject 等宿主的槽位声明出现后再注册，装配顺序无关。
      ctx.inject(["slots"], (scope) => {
        scope.slots.inject(BUNDLE_CONFIG_SLOT, () => scope.slots.register({
          name: BUNDLE_CONFIG_SLOT,
          key: BUNDLE_CONFIG_KEY,
        }, StudioHomeSection));
      });
    }

    exports.apply = apply;
    // 顶层不声明 inject：对底座的依赖降级为可选，底座未安装时本插件静默无操作。
    return module.exports;
  }
});
