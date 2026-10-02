/**
 * agint-evolution-memory: 重建取数器（§4.3.5 的三个证据源 → buildRebuildPlan 的输入）
 *
 * 与 `lib/ledger-rebuild.js` 分开，是因为两边读的东西不一样：
 *   - 推导逻辑必须**纯**（可注入、可单测、可在浏览器里跑）；
 *   - 读文件这件事在宿主侧（工具触发重建）与 CLI 侧（只读核对报告）都要用，
 *     抄两份就会漂移，而漂移的后果是「人核对过的计划」与「实际入链的条目」
 *     不是同一份东西。所以这份实现只有一份，两边都 import 它。
 *
 * ⚠️ 这里**只读**：三个源文件都归别的域所有（event_bus / population），
 * 本插件的权限里没有它们的写份。读取整单元 JSON 而不走 storage 后端是刻意的
 * ——走后端就要为别人的域声明 domain、且会把"读到的字节"交给写入方的代码。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT_NAMES = {
  eventBus: 'agint_event_bus',
  population: 'agint_population',
};

/**
 * 仓库根：lib/ → 插件目录 → plugins/ → 仓库根（与 lib/ledger-anchor.js 同一约定）。
 * ⚠️ 部署到 install/ 槽时这个相对层级不成立，preimage 探测会全部落空 ⇒
 * 条目照常重建，只是 `references.preimagePath` 变 null + 标 PARTIAL。
 * 这是**保守方向**的降级（少写一条指不到的引用），不是假装证据还在。
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** 宿主存储目录：DSH_HOME 优先，退回系统用户目录下的 `.dsh`。 */
export function resolveStoragesDir(env = process.env) {
  const base = env.DSH_HOME
    || join(env.USERPROFILE || env.HOME || env.USERPROFILE_PATH || '', '.dsh');
  if (!base) throw new Error('resolveStoragesDir: 拿不到 DSH_HOME / USERPROFILE，无法定位 storages');
  return join(base, 'storages');
}

/**
 * 解析整单元文件（`{ unit:{name,version}, tables:{<table>:{<key>:row}} }`）。
 * 表缺失返回空数组 —— 「这张表还没落表」与「表在但 0 行」在重建侧同义：无证据。
 */
function readUnitTable(path, unitName, table, { expectVersion = 1 } = {}) {
  if (!existsSync(path)) throw new Error(`REBUILD_SOURCE_MISSING: ${path} 不存在`);
  const raw = readFileSync(path, 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) throw new Error(`REBUILD_SOURCE_BOM: ${path} 带 UTF-8 BOM`);
  let doc;
  try { doc = JSON.parse(raw); } catch (err) { throw new Error(`REBUILD_SOURCE_UNPARSEABLE: ${path}: ${err.message}`); }
  if (doc?.unit?.name !== unitName) {
    throw new Error(`REBUILD_SOURCE_FOREIGN_UNIT: ${path} 的 unit.name=${JSON.stringify(doc?.unit?.name)}，期望 ${unitName}`);
  }
  if (doc.unit.version !== expectVersion) {
    // 不静默兼容：整单元格式是严格相等校验（§4 取证表），版本对不上说明
    // 读到的根本不是这一版语义的数据，拿它重建出来的历史也就不可信。
    throw new Error(`REBUILD_SOURCE_VERSION: ${path} 的 unit.version=${doc.unit.version}，期望 ${expectVersion}`);
  }
  const rows = doc.tables?.[table];
  if (rows === undefined || rows === null) return [];
  return Object.values(rows).filter((r) => r && typeof r === 'object');
}

/**
 * @param {object} deps
 * @param {string} deps.storagesDir  宿主存储目录（一般是 `~/.dsh/storages`）
 * @param {string} deps.repoRoot     AGINT 仓根（preimage 目录在它下面）
 * @param {string} [deps.preimageDir]
 */
export function createFileSourceLoader({ storagesDir, repoRoot, preimageDir = '.agint-preimage' }) {
  if (!storagesDir || !repoRoot) throw new TypeError('createFileSourceLoader: 需要 storagesDir 与 repoRoot');
  const busFile = join(storagesDir, 'agint_event_bus.json');
  const popFile = join(storagesDir, 'agint_population.json');
  const preimageRoot = join(repoRoot, preimageDir);

  return async function loadSources() {
    const events = readUnitTable(busFile, UNIT_NAMES.eventBus, 'events')
      .filter((r) => r?.envelope)
      .map((r) => ({
        id: r.envelope.id,
        topic: r.envelope.topic,
        occurredAt: r.envelope.occurredAt,
        payload: r.envelope.payload ?? {},
      }));
    const variants = readUnitTable(popFile, UNIT_NAMES.population, 'variants');
    // preimage 路径在事件里是**仓内相对路径**（`.agint-preimage/xxx.bak`），
    // 探测时按 repoRoot 解析，⛔ 不接受绝对路径或 `..`（防被事件内容带着读仓外文件）。
    const preimageStat = (rel) => {
      const clean = String(rel ?? '').replace(/\\/g, '/');
      if (!clean.startsWith(`${preimageDir}/`) || clean.includes('..')) return null;
      const abs = join(repoRoot, clean);
      if (!existsSync(abs)) return { exists: false };
      try {
        const st = statSync(abs);
        return st.isFile() ? { exists: true, size: st.size } : { exists: false };
      } catch {
        return { exists: false };
      }
    };
    return { events, variants, preimageStat, files: { busFile, popFile, preimageRoot } };
  };
}

export { readUnitTable };

/** 按宿主机默认布局接线（env + 仓根都取默认值）。测试请直接用 createFileSourceLoader。 */
export function createDefaultSourceLoader({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  return createFileSourceLoader({ storagesDir: resolveStoragesDir(env), repoRoot });
}
