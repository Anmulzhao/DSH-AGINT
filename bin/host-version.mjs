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

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAsarPackage, readAsarFile, findHostAppAsar } from './asar-read.mjs';

/** 仓库根（bin/ 的上一级）。与 asar-read.mjs 同口径，但那边没导出，这里自算。 */
const REPO_ROOT_HERE = join(dirname(fileURLToPath(import.meta.url)), '..');

export { findHostAppAsar, readAsarPackage, readAsarFile };

/**
 * 判断本机是不是「npm/CLI 安装」形态的 dsh（≠ Electron 桌面版）。
 *
 * 判据（任一成立即认为 CLI）：
 *   ① 能找到 `@deepseek-ai/dsh/package.json` 且其旁边**没有** `resources/app.asar`；
 *   ② 环境变量 `DSH_HOST_APP_ASAR` 显式指向不存在的路径 **且** 未在 AGENTS.local.md 配锚点
 *      —— 这种情况属于「配错了」，仍按 unknown 处理（见 checkHostVersion 的分支顺序）。
 *
 * ⚠️ 为什么不用 `process.platform` 判定：桌面版 dsh 也有 Linux 构建（本机平台就是
 *    linux/arm64），用平台判会把「Linux 桌面版」误判成 CLI —— 那才是真假绿。
 *    只有「装在哪、有没有 resources/」这两个事实是可靠的。
 *
 * @param {object} [opts] 透传 env / repoRoot
 * @returns {boolean}
 */
export function isCliInstallation({ env = process.env, repoRoot = null } = {}) {
  const e = env ?? {};
  // 用户显式指了一个不存在的 asar ⇒ 是配置问题，不是形态问题，交给 unknown 分支
  if (e.DSH_HOST_APP_ASAR) return false;

  const root = repoRoot ?? REPO_ROOT_HERE;
  try {
    const localFile = join(root, 'AGENTS.local.md');
    if (existsSync(localFile)) {
      const m = /^\s*hostAppAsar\s*:\s*(.+?)\s*$/m.exec(readFileSync(localFile, 'utf8'));
      if (m) return false;   // 配了锚点却扫不到 ⇒ unknown（配置错），不是 CLI
    }
  } catch { /* 读不到继续往下判 */ }

  // 判据①：npm 全局安装树里能找到 dsh 包，且同层无 resources/
  //
  // ⛔ 这里**只许用调用方传进来的 env**，不许回探 `process.execPath` / 真实 PATH：
  //    测试注入隔离 env（`{ DSH_HOST_APP_ASAR:'', LOCALAPPDATA: tmpDir }`）就是为了
  //    模拟「三个来源全失效」。若此时还去本机找 node 旁边的 dsh，就会把
  //    「这台机器上查不到宿主」误判成「这台机器是 CLI 形态」——
  //    既有用例 test/host-version.test.mjs:180 立刻变红，而且红得对。
  //    判据要保持可被真跑，就不能偷偷读进程状态。
  const candidates = [];
  const pushBin = (binPath) => {
    if (!binPath) return;
    // <prefix>/bin/dsh ⇒ <prefix>/lib/node_modules/@deepseek-ai/dsh
    candidates.push(join(dirname(binPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  };

  // NVM_BIN 优先；否则从传入的 PATH 里找 dsh 可执行文件
  // ⚠️ 2026-11-08 修：PATH 分隔符写死 ':' ⇒ Windows 上（分隔符 ';'）永远切不开，
  // isCliInstallation 恒 false ⇒ CLI 形态被误报成 host-version-unknown。
  // 用 path.delimiter：Windows ';' / POSIX ':'，跨平台自动对。
  // 实证：test/host-version.test.mjs 的「CLI 形态 ⇒ not-applicable」用例在本机一直红。
  if (e.NVM_BIN) pushBin(join(e.NVM_BIN, 'dsh'));
  for (const p of String(e.PATH ?? '').split(delimiter)) {
    if (!p) continue;
    pushBin(join(p, 'dsh'));
  }

  const seen = new Set();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (existsSync(join(c, 'package.json')) && !existsSync(join(c, 'resources', 'app.asar'))) {
      return true;
    }
  }
  return false;
}

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
    // ── 2026-11-03 补：区分「配错了」与「这台机器压根没有桌面宿主」──────────
    // 原实现只有一条 host-version-unknown，措辞是「未找到 ⇒ 没核对」。
    // 问题是它把两种情况说成同一件事：
    //   (a) Electron 桌面版用户，只是 asar 没扫到（配错了，该去补路径）；
    //   (b) **npm 装的 CLI**（本机就是：nvm 下 @deepseek-ai/dsh，无 resources/，
    //       全盘无 *.asar）—— 根本没有第二个「宿主」，门禁判据树**就是**宿主本体。
    // 情况 (b) 下报「未核对宿主版本」是**假警报**：它暗示有另一个宿主在跑旧版本，
    // 而实际上没有。这条 INFO 自 2026-10-21 起一直挂在门禁输出里，正是这个成因。
    //
    // ⇒ 判定为 CLI 安装时给一条 **not-applicable** 级的说明，并明确指出
    //    「此时判据树与宿主同体，版本一致性由 dsh --version 与判据树同源保证」。
    //    仍然保留 info 级（不升不降），因为「有没有第二个宿主」这件事不由本门禁决定。
    if (isCliInstallation(opts)) {
      return [{
        level: 'info',
        kind: 'host-version-not-applicable',
        message:
          '本机是 **npm/CLI 安装**的 dsh（无 Electron resources/app.asar）⇒ '
          + '不存在「另一个宿主」：门禁的判据树就是宿主本体，'
          + '宿主版本一致性由判据树自身版本保证（本次判据版本即宿主版本）。'
          + '**这不是缺失，是形态不同。**',
        remedy:
          '仅当本机另跑了 Electron 桌面版 dsh 时才需要锚点：设 '
          + 'DSH_HOST_APP_ASAR=<桌面版>/resources/app.asar，或在 AGENTS.local.md 写 '
          + '`hostAppAsar: <路径>`（该文件不入库）。',
      }];
    }
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
