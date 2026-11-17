// bin/check-llm-selection-parity.test.mjs —— 模型选择漂移门禁的红绿自证
//
// 门禁最危险的失败模式是**假绿**：扫不出东西却报 PASS。这里两组对拍：
//   ① 负例 —— 注释里的旧模型名、满仓的 `@deepseek-ai/*` 包名不得被报
//      （否则门禁会被立刻绕过或退化成噪音）；
//   ② 正例 —— 真漂移必须被报：模型 id 漂、档位漂、没读宿主选择、插件漏登记、
//      宿主默认选择自己写错。
// 全部走纯函数，不依赖本机 DSH_HOME / 宿主 profile，换机器跑结果一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_LLM_PLUGINS,
  stripCommentLines,
  modelTokensInSource,
  effortValuesInSource,
  parseHostCatalog,
  evaluate,
} from './check-llm-selection-parity.mjs';

const PATCH = [
  {
    id: 'llm-pi-ai',
    config: {
      providers: {
        'minimax-cn': {
          models: [{
            id: 'MiniMax-M3.1-Flash',
            reasoningEfforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
          }],
        },
      },
    },
  },
  { id: 'agent-default-model', config: { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' } },
];

const host = parseHostCatalog(PATCH);
const plugins = KNOWN_LLM_PLUGINS.map((name) => ({
  name,
  hasHostSelection: true,
  tokens: [
    { file: `plugins/${name}/lib/x.js`, line: 1, token: 'minimax-cn' },
    { file: `plugins/${name}/lib/x.js`, line: 2, token: 'MiniMax-M3.1-Flash' },
  ],
  efforts: [{ file: `plugins/${name}/lib/x.js`, line: 3, value: 'high' }],
}));
const codes = (fs) => fs.map((f) => f.code);

// ── ① 负例：不该报 ────────────────────────────────────────────────────────

test('注释行不参与判定（事故记录里的旧模型名不该打红）', () => {
  const src = [
    "// 2026-10-28 事故：常量写 MiniMax-M3.1-Flash，宿主只注册 -Preview",
    " * old value MiniMax-M3.1-Flash-Preview 不可路由",
    "import { defineDomain } from '@deepseek-ai/dsh-storage-domain';",
    "const DEFAULT_MODEL = 'MiniMax-M3.1-Flash';",
  ].join('\n');
  assert.equal(stripCommentLines(src).split('\n').length, 2);
  const tokens = modelTokensInSource(src).map((t) => t.token);
  assert.deepEqual(tokens, ['MiniMax-M3.1-Flash']);
});

test('@deepseek-ai 包名不得被当成模型 id（裸 deepseek 会造 18 条假红）', () => {
  const src = [
    "import { defineTool } from '@deepseek-ai/dsh-tools';",
    "import { defineDomain } from '@deepseek-ai/dsh-storage-domain';",
    "const REPO_SLUG = 'deepseek-ai/deepseek-harness';",
  ].join('\n');
  assert.deepEqual(modelTokensInSource(src), []);
});

test('基座齐全时全绿（证明判据真的跑过而不是空转）', () => {
  assert.equal(evaluate({ host, plugins }).length, 0);
  assert.equal(host.providers['minimax-cn'].models[0].id, 'MiniMax-M3.1-Flash');
});

test('parseHostCatalog：顶层不是数组 ⇒ null（拒绝假绿）', () => {
  assert.equal(parseHostCatalog({ id: 'llm-pi-ai' }), null);
  const empty = parseHostCatalog([]);
  assert.deepEqual(empty.providers, {});
  assert.equal(evaluate({ host: empty, plugins }).some((f) => f.code === 'HOST_CATALOG_EMPTY'), true);
});

// ── ② 正例：真漂移必须被报 ────────────────────────────────────────────────

test('工具描述里残留 -Preview 会被抓（文档漂移也算漂移）', () => {
  const src = "model: { type: 'string', description: '默认模型（MiniMax-M3.1-Flash-Preview）' },";
  const tokens = modelTokensInSource(src);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].token, 'MiniMax-M3.1-Flash-Preview');
  const bad = structuredClone(plugins);
  bad[0].tokens.push({ file: 'lib/tools.js', line: 9, token: tokens[0].token });
  assert.ok(codes(evaluate({ host, plugins: bad })).includes('STALE_MODEL_LITERAL'));
});

test('兜底常量与宿主目录漂移 ⇒ STALE_MODEL_LITERAL', () => {
  const bad = structuredClone(plugins);
  bad[2].tokens.push({ file: 'lib/index.js', line: 7, token: 'MiniMax-M3.1-Flash-Preview' });
  const fs = evaluate({ host, plugins: bad });
  assert.ok(codes(fs).includes('STALE_MODEL_LITERAL'));
  assert.match(fs.find((f) => f.code === 'STALE_MODEL_LITERAL').detail, /agint-evolution-driver/);
});

test('推理档位不在宿主 reasoningEfforts ⇒ STALE_EFFORT_LITERAL', () => {
  const bad = structuredClone(plugins);
  bad[0].efforts.push({ file: 'lib/llm-enhance.js', line: 12, value: 'ultra' });
  assert.ok(codes(evaluate({ host, plugins: bad })).includes('STALE_EFFORT_LITERAL'));
  assert.equal(effortValuesInSource("const DEFAULT_REASONING_EFFORT = 'high';")[0].value, 'high');
});

test('某个插件没读 agentDefaultModel ⇒ NO_HOST_SELECTION', () => {
  const bad = structuredClone(plugins);
  bad[3].hasHostSelection = false;
  const fs = evaluate({ host, plugins: bad });
  assert.ok(codes(fs).includes('NO_HOST_SELECTION'));
  assert.match(fs.find((f) => f.code === 'NO_HOST_SELECTION').detail, /agint-skill-autocreate/);
});

test('新增 LLM 插件未登记 / 已知插件消失，都报', () => {
  const extra = [...structuredClone(plugins), { name: 'agint-new-llm', hasHostSelection: true, tokens: [], efforts: [] }];
  assert.ok(codes(evaluate({ host, plugins: extra })).includes('LLM_PLUGIN_UNREGISTERED'));
  const missing = structuredClone(plugins).filter((p) => p.name !== 'agint-dream');
  assert.ok(codes(evaluate({ host, plugins: missing })).includes('LLM_PLUGIN_MISSING'));
});

test('宿主 agent-default-model 自己写错也报（配置侧漂移）', () => {
  const badPatch = structuredClone(PATCH);
  badPatch[1].config.model = 'MiniMax-M3.1-Flash-Preview';
  assert.ok(codes(evaluate({ host: parseHostCatalog(badPatch), plugins })).includes('HOST_DEFAULT_MODEL_UNKNOWN'));
  const badProvider = structuredClone(PATCH);
  badProvider[1].config.provider = 'openai';
  assert.ok(codes(evaluate({ host: parseHostCatalog(badProvider), plugins })).includes('HOST_DEFAULT_PROVIDER_UNKNOWN'));
});

test('宿主目录空 ⇒ 直接 FAIL，不继续对拍（fail-closed）', () => {
  const fs = evaluate({ host: { providers: {}, defaultSelection: null }, plugins });
  assert.deepEqual(codes(fs), ['HOST_CATALOG_EMPTY']);
});
