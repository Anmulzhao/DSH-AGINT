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
 * 独立成模块而不是塞进门禁脚本，是因为门禁脚本顶层会 `process.exit`，
 * 无法被单测 import（check-soundness 纪律：判据必须可被真跑）。
 */

import { readAsarPackage, findHostAppAsar } from './asar-read.mjs';

export { findHostAppAsar, readAsarPackage };

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
  const pkg = readAsarPackage(host.path);
  if (!pkg) {
    return [{
      level: 'info',
      kind: 'host-version-unread',
      message: `宿主 app.asar 读不出版本（${host.path}）⇒ 同样**没核对**宿主版本。`,
      remedy: '确认该路径是 Electron 桌面版的 resources/app.asar。',
    }];
  }
  if (pkg.version === judgedVersion) return [];
  return [{
    level: 'critical',
    kind: 'host-version-mismatch',
    message:
      `宿主版本（${pkg.name}@${pkg.version}，来自 ${host.path}）`
      + `与门禁判据版本（@deepseek-ai/dsh@${judgedVersion}）**不一致**`
      + ' ⇒ 本门禁的结论对真实宿主无效（假绿）：宿主已升级，AGINT 仍跑旧 dsh。',
    remedy:
      '把解析根（$DSH_HOME/.agint-deps/dsh-runtime）与仓内 node_modules 同步到宿主版本，'
      + '或按宿主当前版本重装 AGINT 依赖树，然后重跑本门禁。',
  }];
}
