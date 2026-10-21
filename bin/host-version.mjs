/**
 * 宿主版本对照（2026-10-21）—— 消「兼容门禁对着 dsh 副本判、对真实宿主失明」的假绿。
 *
 * ## 问题形状
 *
 * 兼容门禁 `check-dsh-compat.mjs` 的判据是**某个 dsh 包副本**
 * （本机解析到的是仓内 `node_modules/@deepseek-ai/dsh`，或
 * `$DSH_HOME/.agint-deps/dsh-runtime`）。
 * 而**真实宿主**是 Electron 桌面版的 `resources/app.asar`
 * （把 dsh 打进了 `@deepseek-ai/dsh-desktop-runtime`）。
 *
 * 宿主升级而副本不动 ⇒ 门禁对着旧副本说「兼容」⇒ **假绿**：
 * 门禁说没事，实际 AGINT 的插件跑在旧 dsh 上、宿主已换版本。
 *
 * 本模块把「真实宿主版本」拉进判据：
 *   · 宿主版本 == 门禁判据版本 ⇒ 无问题
 *   · 不一致 ⇒ **critical**（门禁结论对宿主无效）
 *   · 宿主查不到 ⇒ **info**，措辞明确说「没查」——**绝不报"一致"**
 *
 * 独立成模块而不是塞进门禁脚本，是因为门禁脚本顶层会 `process.exit`
 * （`bin/check-dsh-compat.mjs:468` `process.exit(failed ? 1 : 0)`）⇒ 脚本被 import 时
 * 会当场退出宿主进程，单测拿不到返回值（check-soundness 纪律：判据必须可被真跑）。
 */

import { readAsarPackage, readAsarFile, findHostAppAsar } from './asar-read.mjs';

export { findHostAppAsar, readAsarPackage, readAsarFile };

/**
 * 宿主版本 vs 门禁判据版本。
 *
 * @param {string} judgedVersion 门禁判据用的 dsh 版本
 * @param {object} [opts] 透传给 findHostAppAsar（env / repoRoot）
 * @returns {Array<{level: string, kind: string, message: string, remedy?: string}>}
 */
export function checkHostVersion(judgedVersion, opts = {}) {
  const host = findHostAppAsar(opts);
  if (!host) {
    return [{
      level: 'info',
      kind: 'host-version-unknown',
      message:
        '未找到真实宿主的 app.asar ⇒ **本门禁没有核对宿主版本**（是没查，不是核对过）。'
        + '宿主升级后此门禁可能对真实宿主失明。',
      remedy:
        '设 DSH_HOST_APP_ASAR=<dsh 安装目录>/resources/app.asar，或在 AGENTS.local.md 写 '
        + '`hostAppAsar: <路径>`（该文件不入库）。',
    }];
  }
  const found = resolveHostDshVersion(host.path);
  if (!found) {
    return [{
      level: 'info',
      kind: 'host-version-unread',
      message: `宿主 app.asar 读不出 dsh 运行时版本（${host.path}）⇒ 同样**没核对**宿主版本。`,
      remedy: '确认该路径是 Electron 桌面版的 resources/app.asar。',
    }];
  }
  if (found.version === judgedVersion) return [];
  return [{
    level: 'critical',
    kind: 'host-version-mismatch',
    message:
      `宿主 dsh 运行时版本（${found.version}，来源 ${found.source}，来自 ${host.path}）`
      + `与门禁判据版本（@deepseek-ai/dsh@${judgedVersion}）**不一致**`
      + ' ⇒ 本门禁的结论对真实宿主无效（假绿）：宿主已升级，AGINT 仍跑旧 dsh。',
    remedy:
      '把解析根（$DSH_HOME/.agint-deps/dsh-runtime）与仓内 node_modules 同步到宿主版本，'
      + '或按宿主当前版本重装 AGINT 依赖树，然后重跑本门禁。',
  }];
}

/**
 * 解析宿主**实际运行的 dsh 运行时**版本。
 *
 * ⚠️ 为什么不能直接用 asar 根 package.json 的 version：
 *   根 package.json 是**桌面应用**（`@deepseek-ai/dsh-desktop`）的版本，
 *   与 dsh 运行时（`@deepseek-ai/dsh`）是**两条独立的版本轨道**。
 *   2026-10-21 实测两者恰好都是 `0.2.1-rc.2` ⇒ 用错也不会红，
 *   但上游**只升运行时不升应用版号**时，用根版本比就会**假绿**。
 *   ⇒ 优先读宿主真正加载的 dsh 包。
 *
 * 来源优先级（实测自本机 app.asar 结构）：
 *   ① `dsh/node_modules/@deepseek-ai/dsh/package.json` —— 宿主实际运行的 dsh 包
 *      （宿主把 dsh 打进 asar 的 `dsh/node_modules/`，是**打包产物**，文件名带 hash）
 *   ② `dsh/desktop-runtime.json` 的 `release.version` —— 宿主自述的运行时版本
 *      （`sharedPackages` 里也逐包列了版本，可交叉验证）
 *   ③ asar 根 `package.json` —— 桌面应用版本（**兜底，且语义不同**，会在消息里标注）
 *
 * @param {string} asarPath app.asar 路径
 * @returns {{version: string, source: string} | null}
 */
export function resolveHostDshVersion(asarPath) {
  const dshPkg = readAsarPackage(asarPath, 'dsh/node_modules/@deepseek-ai/dsh/package.json');
  if (dshPkg?.version) {
    return { version: dshPkg.version, source: 'asar:dsh/node_modules/@deepseek-ai/dsh' };
  }
  const rtText = readAsarFile(asarPath, 'dsh/desktop-runtime.json');
  if (typeof rtText === 'string') {
    try {
      const rt = JSON.parse(rtText);
      const v = rt?.release?.version;
      if (typeof v === 'string' && v) return { version: v, source: 'asar:dsh/desktop-runtime.json#release.version' };
    } catch { /* 继续往下兜底 */ }
  }
  const appPkg = readAsarPackage(asarPath, 'package.json');
  if (appPkg?.version) {
    return { version: appPkg.version, source: 'asar:package.json（⚠️ 桌面应用版本，非 dsh 运行时版本）' };
  }
  return null;
}
