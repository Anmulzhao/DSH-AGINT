/**
 * bin/check-tool-output-runtime.mjs
 *
 * 仓级门禁：每个工具 execute() 的**运行时返回值**必须过自己的 output.schema。
 *
 * 背景（提案 1255b37a / 修�� commit 2612b9a）：
 *   plugins/agint-self-model/test/tool-output-conformance.test.mjs 是样板（单模块版）。
 *   样板证明：编译期门禁（output.schema 能否过 dsh 值 schema 编译器）**看不到**返回值。
 *   裸返回数组的工具能编译通过、旧测试全绿，直到 host 运行时第二道门报：
 *     returned invalid output: "value" must be an object
 *
 * 本文件是样板的仓级版（样板头部「中期（仓级门禁，第 2 条）」指定的目标文件）。
 *
 * 判据口径（与样板完全一致，不复述规则）：
 *   validateJsonSchemaValue(tool.output.schema, await tool.execute(...)) 必须返回**空数组**。
 *   宿主实现（两份副本行号一致，3811 行同一文件）：
 *     运行时副本 <dsh-runtime>/node_modules/@deepseek-ai/dsh-tools/lib/index.js:531
 *       function validateJsonSchemaValue(schema, value, path = "value") { return checkValue(schema, value, path); }
 *     宿主真身 app.asar!dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js:531
 *   defineTool（第 838 行）已在注册时把作者 DSL 编译成 raw JSON Schema（第 849 行），
 *   所以 tool.output.schema 直接喂 validateJsonSchemaValue；**不得**再过 valueSchemaSpecToJsonSchema
 *   （raw 的根层 required 数组不是作者 DSL 形态，重编译会抛）。
 *
 * 三条硬要求（抄自样板，逐条落实）：
 *   (1) 每个模块配**该模块真实形状**的服务替身（fixture），
 *       禁止「对任何服务返回 []」的通用桩（实测通用桩会把已证清白的模块也标红 = 假红）。
 *   (2) 每模块至少一条**否定对照**：同一 schema 下喂必然违规的值，
 *       断言违规数组非空、且 assertConforms 抛错 ⇒ 护栏不是空转。
 *   (3) 正向用例必须走到**非空**分支（空分支会假绿）。
 *
 * 退出码（本仓铁律：查不到 ≠ 通过）：
 *   0 = 全部查过且全过
 *   1 = 有 FAIL（返回值过不了自己的 schema，或否定对照失效）
 *   2 = 有模块「没查」（注册表里没有该模块的 fixture / 模块文件缺失）
 *
 * 用法：node bin/check-tool-output-runtime.mjs          （人读格式）
 *       node bin/check-tool-output-runtime.mjs --json    （机器可读）
 *       node --test bin/check-tool-output-runtime.test.mjs （自测）
 *
 * cwd 必须是仓库根。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
