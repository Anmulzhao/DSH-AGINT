import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

/**
 * 部署位 preset 的**相对行可导入性**护栏（2026-10-21 立项）。
 *
 * ## 为什么要有这条
 *
 * 智进 preset 的 25 个工具行（`agint-memory-tools` / `agint-cron-tools` / …）在
 * 部署位是**相对路径**：`../../profiles/desktop/plugins/<plugin>/lib/tools.js`。
 * 这些文件按**裸包名** import 官方包（`@deepseek-ai/dsh-tools`），解析入口是
 * `profiles/<p>/plugins/node_modules/@deepseek-ai/`。
 *
 * 2026-10-21 实测事故：该入口下只有 3 个包（cordis / dsh-storage-domain / dsh-tools），
 * 而 `dsh-tools@0.2.1-rc.2` 的 `lib/index.js` 还裸 import `@deepseek-ai/dsh-scope`
 * （**它自己的 package.json 里都没声明这个依赖**）⇒ 解析不到 ⇒
 * **25 个工具行 import 全炸**（`ERR_MODULE_NOT_FOUND`）⇒ 智进 preset 挂得上、
 * 但一个 agint 工具都没有，界面**没有任何报错**。
 *
 * 这与 2026-10-06 的 dsh-tools stub 事故同族：症状都是「工具全灭、界面不报错」，
 * 差别只在根因（那次是 stub，这次是依赖树不全）。
 *
 * ## 本护栏做什么
 *
 * 直接把部署位 preset 里每个**相对行**真 import 一遍。import 失败就是挂载必炸，
 * 立刻报出来。解析不出行名、文件不存在、依赖缺失，三种都算炸。
 *
 * 部署位不存在时（本机没装 / CI）整条跳过，不阻断。
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
const PRESETS_DIR = path.join(DSH_HOME, '.agent-presets');

function presetFiles() {
  if (!fs.existsSync(PRESETS_DIR)) return [];
  return fs.readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== 'node_modules')
    .map((d) => path.join(PRESETS_DIR, d.name, 'agent.cordis.yml'))
    .filter((p) => fs.existsSync(p));
}

/** 取 preset 文件里所有行：{ id, name }。 */
function readRows(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const id = line.match(/^\s*-\s+id:\s+(\S+)\s*$/);
    if (id) rows.push({ id: id[1], name: null });
    const name = line.match(/^\s*name:\s*['"]?([^'"]+)['"]?\s*$/);
    if (name && rows.length) rows[rows.length - 1].name = name[1].trim();
  }
  return rows;
}

const presets = presetFiles();

test('部署位存在时，preset 的每个相对行都必须能 import', async (t) => {
  if (presets.length === 0) {
    t.skip(`部署位不存在（${PRESETS_DIR}）—— 跳过`);
    return;
  }
  for (const preset of presets) {
    const dir = path.dirname(preset);
    const name = path.basename(dir);
    const relative = readRows(preset).filter((r) => r.name && r.name.startsWith('../'));
    await t.test(`${name}（${relative.length} 个相对行）`, async () => {
      const failures = [];
      for (const row of relative) {
        const abs = path.resolve(dir, row.name);
        if (!fs.existsSync(abs)) {
          failures.push(`${row.id}: 文件不存在 ${abs}`);
          continue;
        }
        try {
          await import(pathToFileURL(abs).href);
        } catch (e) {
          failures.push(`${row.id}: ${e.code ?? 'ERR'} ${String(e.message).split('\n')[0]}`);
        }
      }
      assert.deepEqual(failures, [], failures.join('\n'));
    });
  }
});

test('部署位 preset 的工具行依赖树完整（dsh-tools 自身依赖可解析）', async (t) => {
  const scope = path.join(DSH_HOME, 'profiles', 'desktop', 'plugins', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
  if (!fs.existsSync(scope)) {
    t.skip(`mirror 位 dsh-tools 不存在（${scope}）—— 跳过`);
    return;
  }
  try {
    await import(pathToFileURL(scope).href);
  } catch (e) {
    assert.fail(
      `mirror 位 dsh-tools 自己 import 失败：${e.code ?? 'ERR'} ${String(e.message).split('\n')[0]}\n` +
        '这会让 preset 的全部工具行一起炸。处置：把 mirror 位的 @deepseek-ai scope 换成\n' +
        '指向 dsh 官方 scope 的整链链接（与 bundle 位同形），别只放三包名单。',
    );
  }
});
