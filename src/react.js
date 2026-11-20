// react 桥接：bundle 内唯一的外部 require('react') 在 entry 的 factory 体内执行
// （宿主以经典 <script> 加载插件，求值阶段无 require），组件经此取用 React。
let impl = null;
export function provideReact(r) { impl = r; }
export default function getReact() { if (impl == null) throw new Error('react bridge not provided'); return impl; }
