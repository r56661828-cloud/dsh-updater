// @you-renjun/dsh-updater — client 插件（注册进 DSH 原生侧栏底部动作槽位 + 「dsh版本更新」弹框）
// 设计文档：~/dsh-explore/dsh-updater-plugin-design.md
// 交互面：/api/dsh-updater/{health,status,check,start,restart}
import { UpdaterRoot } from './UpdaterRoot.jsx';
import { NS, SLOT_NAME } from './constants.js';
import { DICT } from './i18n.js';
import { api } from './api.js';
import { provideReact } from './react.js';

window.__ModuleLoader__.load({
  id: '@you-renjun/dsh-updater',
  factory(require) {
    const React = require('react');
    provideReact(React);

    function makeT(ctx) {
      try { return ctx.locale.bind(NS); } catch { return (k) => k; }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT));
        ctx.effect(() => {
          try { ctx.locale.bind(NS); } catch {}
        });
        ctx.slots.inject(SLOT_NAME, () => ctx.slots.register({
          name: SLOT_NAME, id: 'dsh-updater', order: 100, label: 'dsh updater',
        }, (props) => UpdaterRoot(Object.assign({}, props, { api, t: makeT(ctx) }))));
      },
    };
  },
});
