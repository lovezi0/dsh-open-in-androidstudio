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
