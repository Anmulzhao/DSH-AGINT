/**
 * test/smoke.mjs — agint-quality-sandbox smoke test
 *
 * 2026-10-27 新增：此前本插件**没有** test/ 目录（无 smoke 入口），
 * 仓级门禁 bin/check-wiring.mjs 查 I 判「无 smoke 入口 test/smoke.mjs，漂移无法验证」。
 *
 * 覆盖：
 *   1) cwd 必须是仓库根（门禁按 cwd=REPO_ROOT 跑 smoke，见 bin/check-wiring.mjs:793）
 *   2) 插件可加载：lib/index.js 导出 name / apply / inject / Config
 *   3) 核心服务可注册：apply(ctx) 提供 agint.qualitySandbox
 *   4) in-process 降级路径（ctx.sandbox 缺席时）：runSmoke 对 contract 插件结构检查全过
 *
 * 运行（cwd 必须是仓库根）：
 *   node plugins/agint-quality/agint-quality-sandbox/test/smoke.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(PLUGIN_DIR, "../../..");
const LIB_ENTRY = resolve(PLUGIN_DIR, "lib", "index.js");
const CONTRACT_DIR = resolve(PLUGIN_DIR, "..", "agint-quality-contract");
const RUN_CMD = "cd " + REPO_ROOT + " && node plugins/agint-quality/agint-quality-sandbox/test/smoke.mjs";

/** Windows 下比较路径要忽略大小写。 */
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/** 最小 mock ctx：本插件只用到 get / effect / provide。 */
function makeCtx(provided = {}, services = {}) {
  const disposers = [];
  const ctx = {
    get: (n) => services[n] ?? null,
    inject: (names, cb) => cb(services),
    on: () => {},
    effect: (fn) => { const inner = fn(); if (typeof inner === "function") disposers.push(inner); },
    provide: (key, value) => { provided[key] = value; },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  };
  return { ctx, provided, disposers };
}

test("cwd 必须是仓库根（门禁按 cwd=仓库根 跑 smoke）", () => {
  assert.equal(norm(resolve(process.cwd())), norm(REPO_ROOT), "smoke 必须从仓库根运行：" + RUN_CMD);
});

test("插件可加载：导出 name / apply / inject / Config", async () => {
  const mod = await import(pathToFileURL(LIB_ENTRY).href);
  assert.equal(mod.name, "agint-quality-sandbox");
  assert.equal(typeof mod.apply, "function");
  assert.ok(Array.isArray(mod.inject), "inject 必须是数组");
  assert.ok(mod.inject.includes("sandbox"), "inject 必须声明 sandbox（硬依赖）");
  assert.ok(mod.Config, "必须导出 Config（zod schema）");
});

test("核心服务可注册：apply(ctx) 提供 agint.qualitySandbox", async () => {
  const { ctx, provided } = makeCtx();
  const { apply } = await import(pathToFileURL(LIB_ENTRY).href);
  apply(ctx, {});
  const svc = provided["agint.qualitySandbox"];
  assert.ok(svc, "应注册 agint.qualitySandbox 服务");
  for (const key of ["runSmoke", "backendHealth", "publishSandboxEvent"]) {
    assert.equal(typeof svc[key], "function", "agint.qualitySandbox." + key + " 缺失");
  }
  assert.ok(svc.config, "应暴露 config");
});

test("in-process 降级路径：runSmoke 对 contract 插件结构检查全过", async () => {
  const { ctx, provided } = makeCtx();
  const { apply } = await import(pathToFileURL(LIB_ENTRY).href);
  apply(ctx, {});
  const svc = provided["agint.qualitySandbox"];
  const result = await svc.runSmoke({ target: { path: CONTRACT_DIR } });
  assert.equal(result.mode, "in-process", "ctx.sandbox 缺席时应降级为 in-process");
  assert.equal(result.ok, true, "contract 插件结构检查必须全过：" + JSON.stringify(result.checks));
  assert.ok(result.checks.length >= 5, "检查项不应少于 5 条");
  for (const c of result.checks) {
    assert.equal(c.ok, true, "检查项失败：" + c.name + " → " + c.detail);
  }
});

test("runSmoke 缺 target.path 必须报错（不许静默成功）", async () => {
  const { ctx, provided } = makeCtx();
  const { apply } = await import(pathToFileURL(LIB_ENTRY).href);
  apply(ctx, {});
  const svc = provided["agint.qualitySandbox"];
  await assert.rejects(() => svc.runSmoke({}), /target.path/);
});
