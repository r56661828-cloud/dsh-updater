export const NS = 'dsh-updater';
// 升级入口嵌进 DSH 原生左侧栏底部的动作槽位（kind=list，位于设置旁边），
// 不再用 shell.overlay 全局浮层 + position:fixed 定位，避免与原生控件抢位置。
export const SLOT_NAME = 'sidebar.footer.action';
export const CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;
export const POLL_MS = 1000;
export const RETRY_MS = 2500;
