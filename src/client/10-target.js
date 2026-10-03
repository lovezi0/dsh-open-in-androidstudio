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
