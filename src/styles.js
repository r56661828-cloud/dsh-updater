export const CSS = `
.dupd-root { font: inherit; color: var(--dsw-alias-label-primary); }
.dupd-backdrop { position: fixed; inset: 0; z-index: 13000; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; }
.dupd-modal { width: min(620px, calc(100vw - 48px)); max-height: min(78vh, 720px); overflow: auto; background: var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.3); padding: 18px 20px; }
.dupd-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dupd-modal-title { margin: 0; font-size: 17px; font-weight: 650; }
.dupd-modal-close { background: none; border: none; color: var(--dsw-alias-label-secondary); font-size: 15px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
.dupd-modal-close:hover { background: var(--dsw-alias-bg-layer-2); }
.dupd-subtitle { margin: 6px 0 12px; font-size: 13px; color: var(--dsw-alias-label-secondary); }
.dupd-steps-wrap { margin: 10px 0; }
.dupd-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.dupd-step { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-size: 13px; }
.dupd-step-icon { flex: none; width: 16px; text-align: center; }
.dupd-done .dupd-step-icon { color: var(--dsw-alias-state-success-primary); }
.dupd-failed .dupd-step-icon { color: var(--dsw-alias-state-error-primary); }
.dupd-warn .dupd-step-icon { color: var(--dsw-alias-state-warn-primary); }
.dupd-running .dupd-step-icon { font-size: 0; }
.dupd-running .dupd-step-icon::before { content: ''; display: block; width: 13px; height: 13px; margin: 0 auto; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); border-radius: 50%; animation: dupd-spin 0.8s linear infinite; }
.dupd-step-result { opacity: .78; word-break: break-all; }
.dupd-step-live { opacity: .6; }
@keyframes dupd-spin { to { transform: rotate(360deg); } }
.dupd-banner { padding: 8px 12px; border-radius: 8px; font-size: 13px; margin: 8px 0; }
.dupd-banner.dupd-warn { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent); }
.dupd-banner.dupd-info { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); }
.dupd-banner.dupd-error { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 18%, transparent); }
.dupd-banner.dupd-muted { opacity: .7; }
.dupd-btn { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); cursor: pointer; }
.dupd-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-overlay); }
.dupd-btn:disabled { opacity: .5; cursor: default; }
.dupd-btn.dupd-primary { background: var(--dsw-alias-button-primary-fill); border-color: transparent; color: var(--dsw-alias-label-primary-foreground); }
.dupd-btn.dupd-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.dupd-modal-actions { display: flex; align-items: center; gap: 10px; justify-content: flex-end; margin-top: 14px; flex-wrap: wrap; }
.dupd-empty { opacity: .6; font-size: 13px; padding: 10px 0; color: var(--dsw-alias-label-secondary); }
.dupd-manual { margin-top: 10px; padding: 10px 12px; border: 1px dashed var(--dsw-alias-border-l1); border-radius: 8px; font-size: 12px; }
.dupd-manual-title { font-weight: 600; margin-bottom: 6px; }
.dupd-manual-item { opacity: .85; padding: 2px 0; }
.dupd-error { color: var(--dsw-alias-state-error-primary); }
`;
