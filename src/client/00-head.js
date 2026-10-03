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
