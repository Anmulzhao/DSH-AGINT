/**
 * test/smoke.mjs — agint-quality-report smoke test
 *
 * 2026-10-27 新增：此前本插件**没有** test/ 目录（无 smoke 入口），
 * 仓级门禁 bin/check-wiring.mjs 查 I 判「无 smoke 入口 test/smoke.mjs，漂移无法验证」。
 *
 * 覆盖：
 *   1) cwd 必须是仓库根（门禁按 cwd=REPO_ROOT 跑 smoke，见 bin/check-wiring.mjs:793）
 *   2) 插件可加载：lib/index.js 导出 name / apply / inject / Config
 *   3) 核心服务可注册：apply(ctx) 提供 agint.qualityReporter
 *   4) generate 走 FROZEN 契约：返回 { markdown, json }
 *   5) render 纯函数可用（lib/render.js 独立导出）
 *
 * 运行（cwd 必须是仓库根）：
 *   node plugins/agint-quality/agint-quality-report/test/smoke.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(PLUGIN_DIR, "../../..");
const LIB_ENTRY = resolve(PLUGIN_DIR, "lib", "index.js");
const RENDER_ENTRY = resolve(PLUGIN_DIR, "lib", "render.js");
const RUN_CMD = "cd " + REPO_ROOT + " && node plugins/agint-quality/agint-quality-report/test/smoke.mjs";

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

const DECISION = {
  kind: "PENDING_REVIEW",
  score: 72,
  policyId: "policy-smoke",
  reason: "smoke",
  decidedAt: "2026-10-27T00:00:00.000Z",
};

test("cwd 必须是仓库根（门禁按 cwd=仓库根 跑 smoke）", () => {
  assert.equal(norm(resolve(process.cwd())), norm(REPO_ROOT), "smoke 必须从仓库根运行：" + RUN_CMD);
});

test("插件可加载：导出 name / apply / inject / Config", async () => {
  const mod = await import(pathToFileURL(LIB_ENTRY).href);
  assert.equal(mod.name, "agint-quality-report");
  assert.equal(typeof mod.apply, "function");
  assert.ok(Array.isArray(mod.inject), "inject 必须是数组");
  assert.ok(mod.Config, "必须导出 Config（zod schema）");
});

test("核心服务可注册：apply(ctx) 提供 agint.qualityReporter", async () => {
  const { ctx, provided } = makeCtx();
  const { apply } = await import(pathToFileURL(LIB_ENTRY).href);
  apply(ctx, {});
  const svc = provided["agint.qualityReporter"];
  assert.ok(svc, "应注册 agint.qualityReporter 服务");
  for (const key of ["generate", "writeToWiki", "writeToMemory", "generateAndPersist", "health"]) {
    assert.equal(typeof svc[key], "function", "agint.qualityReporter." + key + " 缺失");
  }
  assert.equal(typeof svc.render, "function", "应暴露 render 纯函数");
  assert.equal(svc.health().serviceAvailable, true);
});

test("generate 走 FROZEN 契约：返回 { markdown, json }", async () => {
  const { ctx, provided } = makeCtx();
  const { apply } = await import(pathToFileURL(LIB_ENTRY).href);
  apply(ctx, {});
  const svc = provided["agint.qualityReporter"];
  const report = await svc.generate({ results: [], decision: DECISION });
  assert.equal(typeof report.markdown, "string", "markdown 必须是字符串");
  assert.ok(report.markdown.includes("D-QAF"), "markdown 必须带报告标题");
  assert.equal(typeof report.json, "object", "json 必须是对象");
  assert.equal(report.json.decision.kind, "PENDING_REVIEW");
  assert.equal(report.json.summary.targetCount, 0);
});

test("render 纯函数可独立使用（lib/render.js）", async () => {
  const { renderReport, formatMarkdown } = await import(pathToFileURL(RENDER_ENTRY).href);
  assert.equal(typeof renderReport, "function");
  assert.equal(typeof formatMarkdown, "function");
  const out = renderReport({ results: [], decision: DECISION });
  assert.equal(typeof out.markdown, "string");
  assert.equal(out.json.summary.targetCount, 0);
});
