# dsh-updater

> 在 DSH 里完成 DSH 自己的升级：检查新版本、向导式安装、重启、升级后自检。

DSH 的升级通常意味着「退出、在终端里装、再启动、手动确认没装坏」。这个插件把这条链路搬进侧栏：有新版时出现一枚「⬆ 更新」小按钮，点开是分步向导，跑完还会自动核对八项，坏了当场告诉你坏在哪。

只盯 `@deepseek-ai/dsh` 的 `latest` 频道，不追预发布。

## 功能

- **版本检查**：读取 registry 的 `dist-tags.latest`，每 3 小时一次心跳，打开面板时也会手动查一次；离线时给出「网络不可用」而不是假装是最新版。
- **两阶段升级，重启杀不掉升级进程**：前台只做校验与编排，真正的 install 放进 `systemd-run --user --scope --unit=dsh-upgrader-bounce` 的独立 cgroup；宿主随后重启时，升级进程不在它的进程树里。
- **分步可见**：备份 → 安装 → 版本核对 → 台账 → 重启 → 自检，每一步都有状态（running / done / warn / failed / manual），失败停在原步并保留错误。
- **升级后自检 S1–S8**：版本是否等于目标、profile 能否重新合成、dump diff 用户层是否零丢失、角色模型钉是否还在、服务是否健康、journal 是否有错误、hooks 三包是否在位、本地插件依赖的宿主版本是否对齐。
- **升级前日志快照**：`journalctl` 全量导出到快照文件（先写 `.tmp` 再 rename），下次出问题能对着看。
- **状态可查**：`~/.dsh/updater/status.json`，页面轮询它，所以刷新页面不会丢进度。

## 安装

从 Gitee 安装（需要 DSH ≥ 0.2.2-rc.1）：

```sh
dsh plugin --profile web add git+https://gitee.com/you-renjun/dsh-updater.git
```

重启 `dsh web` 后，侧栏底部动作槽会在有更新时出现入口。

> 前端产物 `client.js` 已预构建入库；`src/` 只用于开发期重建，不影响安装，不需要 `allowBuilds` 授权。

## 使用

1. 点侧栏底部的「⬆ 更新」（没有新版本时不显示）。
2. 面板里看当前版本 → 目标版本，点「开始升级」。
3. 按提示走完；需要重启时点「立即重启」。
4. 升级结束后看自检八项：全绿即完成，有 `warn` 会写清是哪一项。

## 前提与边界

| 项 | 说明 |
|---|---|
| 系统 | Linux + user systemd（`systemd-run --user`）。没有 user systemd 的环境，bounce 链起不来，会明确报错而不是静默失败。 |
| 可写目录 | 需要写 `~/.dsh/updater/`（状态、日志快照）与 profile 目录（备份、patch）。只读环境会在「备份」一步失败。 |
| 频道 | 只跟 `latest`，预发布版本不会被推荐。 |
| 风险 | 它真的会安装新版本并重启宿主。升级前请确认当前会话已保存。 |

## HTTP 接口

| 路由 | 作用 |
|---|---|
| `GET /api/dsh-updater/health` | 当前版本、频道、启动入口 |
| `GET /api/dsh-updater/status` | 升级进度视图 |
| `POST /api/dsh-updater/check` | 主动查最新版 |
| `POST /api/dsh-updater/start` | 开始升级（目标版本） |
| `POST /api/dsh-updater/restart` | 重启宿主 |
| `POST /api/dsh-updater/selfcheck` | 手动触发自检 |

## 开发

```sh
npm install          # 仅开发期需要
npm run build        # esbuild 重建 client.js
npm test             # vitest：编排、状态机、自检端点、槽位注册
```

- `index.js` — Host 半边：版本比较、升级编排、重启、自检 S1–S8。
- `src/` — 浏览器半边源码（React），构建成 `client.js`。
- `assets/upgrade.mjs` — 真正在独立 scope 里执行的升级脚本。

## 许可证

[MIT](./LICENSE)