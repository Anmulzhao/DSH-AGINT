/**
 * test/smoke.mjs — agint-quality-contract smoke test
 *
 * 2026-10-27 新增：此前本插件**没有** smoke 入口（只有 test/bus-publish.test.mjs），
 * 仓级门禁 bin/check-wiring.mjs 查 I（漂移插件 smoke 验证）判「无 smoke 入口，漂移无法验证」。
 *
 * 覆盖：
 *   1) cwd 必须是仓库根（门禁按 cwd=REPO_ROOT 跑 smoke，见 bin/check-wiring.mjs:793）
 *   2) 插件可加载：lib/index.js 导出 name / apply / inject / Config
 *   3) 核心服务可注册：apply(ctx) 提供 agint.quality（FROZEN 契约层）
 *   4) L0 冻结守卫：validatePatch 拦 L0 / 放行 L1；setConfig 改 L0 必须 throw
 *
 * 运行（cwd 必须是仓库根）：
 *   node plugins/agint-quality/agint-quality-contract/test/smoke.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(PLUGIN_DIR, "../../..");
const LIB_ENTRY = resolve(PLUGIN_DIR, "lib", "index.js");
const RUN_CMD = "cd " + REPO_ROOT + " && node plugins/agint-quality/agint-quality-contract/test/smoke.mjs";

/** Windows 下比较路径要忽略大小写。 */
const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);

/** 最小 mock ctx：只给插件真正用到的那几个口子。 */
function makeCtx(provided = {}) {
  const disposers = [];
  const ctx = {
    get: () => null,
    inject: (names, cb) => cb({}),
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
  assert.equal(mod.name, "agint-quality-contract");
  assert.equal(typeof mod.apply, "function");
  assert.ok(Array.isArray(mod.inject), "inject 必须是数组");
  assert.ok(mod.Config, "必须导出 Config（zod schema）");
});

test("核心服务可注册：apply(ctx) 提供 agint.quality", async () => {
  const { ctx, provided } = makeCtx();
  const { apply } = await import(pathToFileURL(LIB_ENTRY).href);
  apply(ctx, {});
  const svc = provided["agint.quality"];
  assert.ok(svc, "应注册 agint.quality 服务");
  for (const key of ["getConfig", "setConfig", "validatePatch", "getLayer", "isFrozen"]) {
    assert.equal(typeof svc[key], "function", "agint.quality." + key + " 缺失");
  }
  assert.ok(svc.schemas && svc.schemas.EvalTarget, "应暴露 EvalTarget schema");
  assert.ok(svc.interfaces && svc.interfaces.QualityEvaluator, "应暴露 QualityEvaluator 接口定义");
});

test("L0 冻结守卫：validatePatch 拦 L0、放行 L1", async () => {
  const { ctx, provided } = makeCtx();
  const { apply } = await import(pathToFileURL(LIB_ENTRY).href);
  apply(ctx, {});
  const svc = provided["agint.quality"];
  assert.equal(svc.getLayer("EvalTarget"), "L0-frozen");
  assert.equal(svc.isFrozen("EvalTarget"), true);
  assert.equal(svc.getLayer("harmWeights"), "L1-adjustable");
  const bad = svc.validatePatch({ EvalTarget: { id: "x" } });
  assert.equal(bad.ok, false, "改 L0 字段必须被拦下");
  assert.ok(bad.violations.includes("EvalTarget"), "违例清单必须点名 EvalTarget");
  const good = svc.validatePatch({ harmWeights: { H: 0.5 } });
  assert.equal(good.ok, true, "改 L1 字段必须放行");
});

test("setConfig 改 L0 字段必须 throw（L0 红线）", async () => {
  const { ctx, provided } = makeCtx();
  const { apply } = await import(pathToFileURL(LIB_ENTRY).href);
  apply(ctx, {});
  const svc = provided["agint.quality"];
  await assert.rejects(
    () => svc.setConfig({ EvalTarget: { id: "x" } }),
    (err) => { assert.equal(err.code, "L0_FROZEN_VIOLATION"); return true; },
  );
});
