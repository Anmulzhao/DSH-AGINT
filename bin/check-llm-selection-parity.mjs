#!/usr/bin/env node
/**
 * bin/check-llm-selection-parity.mjs —— LLM 模型选择「单一真源」漂移门禁
 *
 * 为什么存在：本仓调 LLM 的插件全走宿主子代理服务面，provider/model 的**运行时真源**
 * 是宿主 `ctx.get('agentDefaultModel').currentSelection()`，配置真源是宿主 profile 的
 * `llm-pi-ai.providers.*.models[].id`。但插件里仍留着离线兜底常量，历史上三次事故
 * 都出在「静态常量 ↔ 宿主运行期目录」漂移，而且每次都静默：
 *   - 2026-10-28 agint-dream P1：常量写 MiniMax-M3.1-Flash，宿主只注册 -Preview
 *     ⇒ P1 从未真正跑通（plugin-preflight/SKILL.md）；
 *   - 2026-11-07 reasoningEfforts 未声明 ⇒ UNSUPPORTED_REASONING_EFFORT
 *     ⇒ promoted 恒 0 ⇒ agint-ov-strategy 的 dream 投影被永久挡死；
 *   - 旧 `subagents.start` ⇒ 四个插件 LLM 通路恒失败还谎报 unavailable。
 *
 * 两条硬判据：
 *   C1 运行时真源：每个调 LLM 的插件，lib 源码必须读 agentDefaultModel.currentSelection()
 *      （只读注释不算；用剔注释后的源码判）。
 *   C2 兜底不腐坏：写进 lib 代码的 provider/model 字面量与推理档位常量，必须存在于
 *      宿主 profile 的模型目录里。宿主换模型 ⇒ 这里立刻红灯，提示同步所有兜底点。
 *   另：宿主 `agent-default-model` 段自身也必须在目录里（配置写错同样红灯）。
 *
 * ⛔ 不解析、不写入、不重启、不调 LLM：这是纯静态只读门禁。
 *
 * 用法：
 *   node bin/check-llm-selection-parity.mjs              人读输出
 *   node bin/check-llm-selection-parity.mjs --json       机器读
 *   node bin/check-llm-selection-parity.mjs --patch <p>  指定宿主 profile patch
 *
 * 退出码：0 = 全绿 / 1 = 有漂移 / 2 = 环境不满足（fail-closed，绝不假绿）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 已知走宿主子代理服务面调 LLM 的插件。自动发现与之对拍，防止新增插件绕过门禁。 */
export const KNOWN_LLM_PLUGINS = [
  'agint-aesthetic-oracle',
  'agint-dream',
  'agint-evolution-driver',
  'agint-skill-autocreate',
  'agint-upstream-watch',
];

/** 调用宿主 LLM 服务面的形态（新旧宿主两种方言都算）。 */
const LLM_CALL_RE = /subagents\.startActivation\s*\(|subagents\.start\s*\(\s*['"]spawn['"]/;
/** 具体 provider / model 名字面量。
 *  ⛔ 不要加裸 `deepseek`：它会命中满仓的 `@deepseek-ai/dsh-*` 包名（18 条假红）。
 *  真把 `deepseek-chat` 当模型 id 写进代码仍会被抓到。 */
const TOKEN_RE = /(MiniMax-[A-Za-z0-9._-]+|minimax-cn|deepseek-chat)/g;
/** 推理档位兜底常量（2026-11-07 事故的另一半）。 */
const EFFORT_CONST_RE = /(?:DEFAULT_REASONING_EFFORT|DEFAULT_EFFORT)\s*=\s*['"]([^'"]+)['"]/g;

/**
 * 剔掉注释行再判代码。块注释内行以 `*` 开头、JSDoc 同理；事故记录写成注释
 * 不该把门禁打红，但只写在注释里的「接入」也不该算数。
 */
export function stripCommentLines(src) {
  return src.split(/\r?\n/)
    .filter((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('//') && !t.startsWith('*')
        && !t.startsWith('/*') && !t.startsWith('#');
    })
    .join('\n');
}

/**
 * 抽出源码里所有引用具体 provider/model 的字符串 token。
 * 只看单/双引号字符串：反引号里的 prompt 正文是自然语言，不是配置。
 *
 * @param {string} src
 * @returns {{line:number, token:string}[]}
 */
export function modelTokensInSource(src) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (stripCommentLines(line) === '') return;
    for (const m of line.matchAll(/'([^']*)'|"([^"]*)"/g)) {
      const literal = m[1] ?? m[2] ?? '';
      for (const t of literal.matchAll(TOKEN_RE)) out.push({ line: i + 1, token: t[0] });
    }
  });
  return out;
}

/** 抽出推理档位兜底常量值。 */
export function effortValuesInSource(src) {
  const out = [];
  src.split(/\r?\n/).forEach((line, i) => {
    if (stripCommentLines(line) === '') return;
    for (const m of line.matchAll(EFFORT_CONST_RE)) out.push({ line: i + 1, value: m[1] });
  });
  return out;
}

/**
 * 从宿主 profile patch（已解析成数组）里取模型目录与默认选择。
 *
 * @param {unknown} doc yaml.load 的结果
 * @returns {{providers:Record<string,{models:{id:string, efforts:string[]}[]}>,
 *            defaultSelection:{provider:string,model:string,reasoningEffort:string|null}|null}|null}
 */
export function parseHostCatalog(doc) {
  if (!Array.isArray(doc)) return null;
  const entry = (id) => doc.find((e) => e && typeof e === 'object' && e.id === id);
  const llm = entry('llm-pi-ai');
  const def = entry('agent-default-model');
  const providers = {};
  for (const [name, cfg] of Object.entries(llm?.config?.providers ?? {})) {
    if (!cfg || typeof cfg !== 'object') continue;
    providers[name] = {
      models: (Array.isArray(cfg.models) ? cfg.models : []).map((m) => ({
        id: typeof m?.id === 'string' ? m.id : null,
        efforts: m?.reasoningEfforts && typeof m.reasoningEfforts === 'object'
          ? Object.keys(m.reasoningEfforts) : [],
      })).filter((m) => m.id),
    };
  }
  const dc = def?.config;
  return {
    providers,
    defaultSelection: dc && typeof dc === 'object'
      ? {
        provider: dc.provider ?? null,
        model: dc.model ?? null,
        reasoningEffort: dc.reasoningEffort ?? null,
      }
      : null,
  };
}

/**
 * 纯对拍（不碰文件系统，便于自测）。
 *
 * @param {{host:ReturnType<typeof parseHostCatalog>,
 *          plugins:{name:string, hasHostSelection:boolean,
 *                   tokens:{file:string,line:number,token:string}[],
 *                   efforts:{file:string,line:number,value:string}[]}[]}} input
 * @returns {{level:'FAIL'|'WARN', code:string, detail:string}[]}
 */
export function evaluate({ host, plugins }) {
  const findings = [];
  const fail = (code, detail) => findings.push({ level: 'FAIL', code, detail });

  if (!host || Object.keys(host.providers).length === 0) {
    fail('HOST_CATALOG_EMPTY', '宿主 profile 里没有 llm-pi-ai.providers 模型目录 —— 无法对拍，拒绝假绿');
    return findings;
  }
  const providerNames = new Set(Object.keys(host.providers));
  const modelIds = new Set(Object.values(host.providers).flatMap((p) => p.models.map((m) => m.id)));
  const efforts = new Set(Object.values(host.providers).flatMap((p) => p.models.flatMap((m) => m.efforts)));

  // C0：宿主默认选择自身必须落在本目录里
  const ds = host.defaultSelection;
  if (ds) {
    if (!providerNames.has(ds.provider)) {
      fail('HOST_DEFAULT_PROVIDER_UNKNOWN', `agent-default-model.provider=${ds.provider} 不在 llm-pi-ai.providers`);
    } else {
      const models = host.providers[ds.provider].models;
      if (!models.some((m) => m.id === ds.model)) {
        fail('HOST_DEFAULT_MODEL_UNKNOWN', `agent-default-model.model=${ds.model} 不在 ${ds.provider} 的 models[].id`);
      }
      const target = models.find((m) => m.id === ds.model);
      if (ds.reasoningEffort && target && !target.efforts.includes(ds.reasoningEffort)) {
        fail('HOST_DEFAULT_EFFORT_UNKNOWN', `agent-default-model.reasoningEffort=${ds.reasoningEffort} 不在 ${ds.model}.reasoningEfforts`);
      }
    }
  }

  // C1 / C2：插件集合与每个插件的接入、兜底值
  const known = new Set(KNOWN_LLM_PLUGINS);
  const actual = new Set(plugins.map((p) => p.name));
  for (const name of KNOWN_LLM_PLUGINS) {
    if (!actual.has(name)) fail('LLM_PLUGIN_MISSING', `已知 LLM 插件 ${name} 未被发现（目录或调用形态变了？）`);
  }
  for (const name of actual) {
    if (!known.has(name)) {
      fail('LLM_PLUGIN_UNREGISTERED', `发现新的 LLM 调用插件 ${name}，请先在本脚本 KNOWN_LLM_PLUGINS 登记并接入宿主选择`);
    }
  }

  for (const p of plugins) {
    if (!p.hasHostSelection) {
      fail('NO_HOST_SELECTION', `${p.name}: lib 源码未读 agentDefaultModel.currentSelection() —— 运行时仍走死常量`);
    }
    for (const t of p.tokens) {
      if (!providerNames.has(t.token) && !modelIds.has(t.token)) {
        fail('STALE_MODEL_LITERAL', `${p.name}/${t.file}:${t.line} 写了宿主目录里不存在的 '${t.token}'`);
      }
    }
    for (const e of p.efforts) {
      if (efforts.size > 0 && !efforts.has(e.value)) {
        fail('STALE_EFFORT_LITERAL', `${p.name}/${e.file}:${e.line} 兜底档位 '${e.value}' 不在宿主模型的 reasoningEfforts`);
      }
    }
  }
  return findings;
}

function listLibFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...listLibFiles(p));
    else if (/\.(?:js|mjs|cjs)$/.test(d.name)) out.push(p);
  }
  return out;
}

/** 自动发现所有真调宿主 LLM 服务面的插件（只看剔注释后的代码）。 */
export function discoverLlmPlugins(repoRoot = REPO_ROOT) {
  const root = path.join(repoRoot, 'plugins');
  const out = [];
  if (!fs.existsSync(root)) return out;
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('_')) continue;
    const files = listLibFiles(path.join(root, d.name, 'lib'));
    if (files.some((f) => LLM_CALL_RE.test(stripCommentLines(fs.readFileSync(f, 'utf8'))))) out.push(d.name);
  }
  return out.sort();
}

function collectPluginFacts(repoRoot, name) {
  const dir = path.join(repoRoot, 'plugins', name, 'lib');
  const tokens = [];
  const effortList = [];
  let hasHostSelection = false;
  for (const f of listLibFiles(dir)) {
    const src = fs.readFileSync(f, 'utf8');
    const code = stripCommentLines(src);
    if (code.includes('agentDefaultModel') && code.includes('currentSelection')) hasHostSelection = true;
    const rel = path.relative(repoRoot, f).replaceAll(path.sep, '/');
    for (const t of modelTokensInSource(src)) tokens.push({ file: rel, ...t });
    for (const e of effortValuesInSource(src)) effortList.push({ file: rel, ...e });
  }
  return { name, hasHostSelection, tokens, efforts: effortList };
}

function resolveHostPatch(explicit) {
  if (explicit) return path.resolve(explicit);
  const home = dsHome();
  let profile = 'web';
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, '.agint-bundle', 'profile.json'), 'utf8'));
    if (typeof j?.profile === 'string' && j.profile) profile = j.profile;
  } catch { /* 取不到就用 web */ }
  const candidates = [
    path.join(home, 'profiles', profile, 'cordis.patch.yml'),
    path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0];
}

function dsHome() {
  return process.env.DSH_HOME
    || path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
}

/** 与 bin/check-patch-yaml.mjs 同口径：从 dsh 自己的依赖树里找 js-yaml。 */
function loadYaml() {
  const bases = [];
  if (process.env.AGINT_DSH_RUNTIME) bases.push(process.env.AGINT_DSH_RUNTIME);
  if (process.env.DSH_ROOT) bases.push(path.join(process.env.DSH_ROOT, 'node_modules'));
  bases.push(path.join(dsHome(), '.agint-deps', 'dsh-runtime', 'node_modules'));
  bases.push(path.join(REPO_ROOT, 'node_modules'));
  for (const base of bases) {
    try {
      const req = createRequire(path.join(base, 'noop.js'));
      return { yaml: req('js-yaml'), from: base };
    } catch { /* 试下一个 */ }
  }
  return null;
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes('--json');
  const pi = argv.indexOf('--patch');
  const patchFile = resolveHostPatch(pi >= 0 ? argv[pi + 1] : null);

  if (!fs.existsSync(patchFile)) {
    const msg = `宿主 profile patch 不存在：${patchFile}（设 DSH_HOME 或用 --patch 指定）`;
    console.error(`[check-llm-selection-parity] [FAIL] ${msg}`);
    if (json) console.log(JSON.stringify({ ok: false, exit: 2, findings: [{ level: 'FAIL', code: 'HOST_PATCH_MISSING', detail: msg }] }, null, 2));
    return 2;
  }
  const loaded = loadYaml();
  if (!loaded) {
    const msg = '找不到 js-yaml：设 AGINT_DSH_RUNTIME（指向 dsh 安装根的 node_modules）或 DSH_ROOT';
    console.error(`[check-llm-selection-parity] [FAIL] ${msg}`);
    if (json) console.log(JSON.stringify({ ok: false, exit: 2, findings: [{ level: 'FAIL', code: 'YAML_PARSER_MISSING', detail: msg }] }, null, 2));
    return 2;
  }

  let host = null;
  let parseError = null;
  try {
    const JsExpr = new loaded.yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      resolve: (data) => typeof data === 'string',
      construct: (data) => ({ __jsExpr: data }),
    });
    host = parseHostCatalog(loaded.yaml.load(fs.readFileSync(patchFile, 'utf8'), {
      schema: loaded.yaml.JSON_SCHEMA.extend(JsExpr),
    }));
  } catch (e) {
    parseError = String(e?.message ?? e).split('\n')[0];
  }

  const pluginNames = discoverLlmPlugins();
  const plugins = pluginNames.map((n) => collectPluginFacts(REPO_ROOT, n));
  const findings = parseError
    ? [{ level: 'FAIL', code: 'HOST_PATCH_UNPARSEABLE', detail: `${patchFile}: ${parseError}` }]
    : evaluate({ host, plugins });

  const fails = findings.filter((f) => f.level === 'FAIL');
  const report = {
    ok: fails.length === 0,
    exit: fails.length === 0 ? 0 : 1,
    patch: patchFile,
    parserFrom: loaded.from,
    providers: Object.fromEntries(Object.entries(host?.providers ?? {}).map(([k, v]) => [k, v.models.map((m) => m.id)])),
    defaultSelection: host?.defaultSelection ?? null,
    plugins: plugins.map((p) => ({ name: p.name, hasHostSelection: p.hasHostSelection, literals: p.tokens.length, efforts: p.efforts.length })),
    findings,
  };

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[check-llm-selection-parity] 宿主模型目录：${patchFile}`);
    for (const [name, v] of Object.entries(report.providers)) console.log(`  ${name}: ${v.join(', ')}`);
    console.log(`  默认选择：${JSON.stringify(report.defaultSelection)}`);
    console.log(`  LLM 插件 ${plugins.length} 个：${plugins.map((p) => `${p.name}(${p.hasHostSelection ? 'host' : 'FIXED'})`).join(', ')}`);
    for (const f of findings) console.log(`  [${f.level}] ${f.code}: ${f.detail}`);
    console.log(fails.length === 0
      ? `  [PASS] ${plugins.length} 个插件均读宿主选择，兜底常量与宿主目录一致`
      : `  [FAIL] ${fails.length} 条漂移`);
  }
  return report.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
