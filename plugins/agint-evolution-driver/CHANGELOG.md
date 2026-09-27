# CHANGELOG — agint-evolution-driver

## 0.1.0 — 2026-09-27

闭环引擎第一次有驱动源。

### 新增

- 插件 `agint-evolution-driver`（Service `agint.evolutionDriver`），职责：把 `agint.evolve`
  的 `proposed` 提案编译成一次真实的变异候选，接进 mutator / population。
- 变异构造走 **subagent（真 LLM）**，结构化输出契约 `MUTATION_OUTPUT_SCHEMA`
  （subagents 方言：`required` 挂父对象数组，K70）。
- **幻觉闸门**：`oldText` 必须是目标文件原文的真实子串，否则丢弃本次、不进 propose。
- 链路：`propose → validate → ingest`，并发布 `evolution.mutation.proposed` /
  `evolution.mutation.rejected`。
- 开关：`AGINT_EVOLUTION_DRIVER=off`（出厂即开）；`AGINT_EVOLUTION_DRIVER_COMMIT=on`（**默认关**）。

### 设计取舍

- **不持存储域**：正本在 `agint_mutator` / `agint_population`，本插件只做驱动，避免第二份真相。
- **定位不到目标就换候选**，不硬凑：提案跟任何 preset skill 都无关时跳过，而不是拿一个不相干的文件凑数。
- **第一阶段不 commit**：改部署位会被 `install.sh` 镜像覆盖，仓库路径问题未解前不动手。

### 测试

- `test/smoke.mjs` T1–T14 全绿（含 kill-switch、幻觉闸门、validate 拒绝、seen 去重）。
