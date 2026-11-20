import React from 'react';
import { provideReact } from '../src/react.js';

provideReact(React);

// reportError 走 api.js 的真实 fetch；测试环境给一个静默兜底，避免环境差异
if (typeof globalThis.fetch !== 'function') {
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({}) });
}
