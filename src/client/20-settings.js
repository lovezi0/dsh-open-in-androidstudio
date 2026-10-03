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
