/** 小程序运行环境全局 API 的最小类型声明，仅供 Node 测试编译使用 */
declare const wx: any;
declare function Page(options: any): any;
declare function Component(options: any): any;
declare function App(options: any): any;
declare function getApp(): any;
declare function getCurrentPages(): any[];

declare namespace WechatMiniprogram {
  interface CustomEvent { detail: any; currentTarget: { dataset: any }; }
  interface TouchEvent { detail: any; currentTarget: { dataset: any }; }
}
declare module 'tdesign-miniprogram/action-sheet/index' { const ActionSheet: any; export default ActionSheet; }
declare module 'tdesign-miniprogram/toast/index' { const Toast: any; export default Toast; }
declare module 'tdesign-miniprogram/dialog/index' { const Dialog: any; export default Dialog; }
