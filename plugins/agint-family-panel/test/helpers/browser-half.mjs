/**
 * 在 node 里加载浏览器半（lib/client.js）。
 *
 * 它不是 ES 模块：跑的时候先调 `window.__ModuleLoader__.load({id, factory})`，
 * factory 里用 `require('react')`。所以这里给两个替身：
 *  - `window`：只提供 `__ModuleLoader__.load`
 *  - `require`：只认 'react'，返回下面这个 createElement 替身
 *
 * 替身不实现 hooks（档案页是纯函数组件，不用到 state）；真用到 hooks 会抛错，
 * 而不是静默返回 undefined —— 这样测试不会假装通过。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = resolve(HERE, '..', '..', 'lib', 'client.js');

/** 只保留元素树需要的三个字段，便于断言。 */
export function createElement(type, props, ...children) {
  const flat = [];
  const push = (c) => { if (Array.isArray(c)) c.forEach(push); else flat.push(c); };
  children.forEach(push);
  return { type, props: props || {}, children: flat };
}

const ReactShim = {
  createElement,
  Fragment: Symbol('Fragment'),
  useState: () => { throw new Error('__test__ 里的组件不应使用 useState'); },
  useEffect: () => { throw new Error('__test__ 里的组件不应使用 useEffect'); },
  useRef: () => ({ current: null }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};

/**
 * @returns {object} 插件模块的导出（含 __test__）
 */
export function loadBrowserHalf() {
  const mods = {};
  const windowShim = { __ModuleLoader__: { load(def) { mods[def.id] = def.factory(requireShim); } } };
  const requireShim = (name) => {
    if (name === 'react') return ReactShim;
    throw new Error(`browser half 不该 require(${name})`);
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'require', readFileSync(CLIENT_PATH, 'utf8'))(windowShim, requireShim);
  const mod = mods['agint-family-panel'];
  if (!mod) throw new Error('client.js 没有注册 agint-family-panel 模块');
  return mod;
}

/** 把元素树展开成纯文本（不含属性），供断言字符串用。 */
export function treeText(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (Array.isArray(node)) return node.map(treeText).join('');
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  const { type, props, children } = node;
  if (typeof type === 'function') {
    const merged = { ...props };
    if (children.length) merged.children = children.length === 1 ? children[0] : children;
    return treeText(type(merged));
  }
  if (type === 'style') return '';
  return children.map(treeText).join('');
}

/** 找树里所有等于某标签名的元素（用于断言表头/行数这类结构事实）。 */
export function findByTag(node, tag, acc = []) {
  if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return acc;
  if (Array.isArray(node)) { node.forEach((n) => findByTag(n, tag, acc)); return acc; }
  const { type, props, children } = node;
  if (typeof type === 'function') {
    const merged = { ...props };
    if (children.length) merged.children = children.length === 1 ? children[0] : children;
    findByTag(type(merged), tag, acc);
    return acc;
  }
  if (type === tag) acc.push(node);
  children.forEach((c) => findByTag(c, tag, acc));
  return acc;
}
