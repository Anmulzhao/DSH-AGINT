# CHANGELOG — agint-evolution-driver

## v0.2.2 — 2026-09-27（干净进程首轮 5/20 进到 LLM，全判 not applicable → 两处根因修正）

### 干净进程实测（18:10 触发，pid 7932）

- **管道端到端全通**：5/20 候选成功解析并真实调用 LLM
  （d85347bf 技能目标 + 52542886/531e2631/04d6199c/cdf41d63 **仓库路径目标**）
  —— v0.2.0 路径解析在真实链路有效；上轮 17:36 全败确证为热重载过渡态污染。
- 5/5 判 `not applicable`。归因两处：① 提案多为「拆分/重构」类多编辑诉求，
  旧规则 3 让 LLM 遇多编辑即拒 —— 设计错配（evolve 提案=特性级，construct=单原子编辑）；
  ② 片段截断 6000 字符 < metrics.js 实际 7334B，提示词却声称给全文。

### 变更

- **规则 3 改写**：提案需要多处编辑时，取「本文件的第一个连贯原子步骤」执行，
  剩余步骤写进 rationale；仅当提案空泛/需新建文件/属别的文件时才 applicable=false。
  单原子编辑 + verbatim 锚 + 幻觉闸门全部不变，边界不扩。
- **DEFAULT_SNIPPET 6000 → 20000**：消除「声称全文实为截断」导致的误判与
  幻觉闸门误伤风险。

## v0.2.1 — 2026-09-27（观测升级：failures 不再藏诊断尾巴）

### 背景

17:36 首轮验收：20 候选全失败，但 summary 的 failures 只留前 10 条
（pool 按 createdAt 倒序处理 ⇒ 被藏的恰是后处理的 10 条）。已知 3 条候选
（cdf41d63 / 04d6199c / 52542886）的提案正文含真实存在的仓库路径
（如 `plugins/agint-metrics/lib/metrics.js`），按同版代码离线复现**能命中**，
实跑却未见其 spawn 子代理 ⇒ 其真实失败原因被 cap 隐藏，无法取证。
另注：该轮跑在热重载过渡态的旧进程上（17:11 boot v0.1.x，17:31 才同步 v0.2.0），
结果本身可信度存疑；当前进程已干净重启加载 v0.2.x。

### 变更

- **failures 上限 10 → 30**（pool 上限 20，等价全量）：不再藏诊断尾巴。
- **no-target 失败串附诊断**（新 `resolutionDiag`）：`mentioned:N inRepo:H
  bodyLen:L` —— 提案文本里反引号路径数、真实命中仓库数、body 长度。
  下一轮无论结果如何都能一步定位「路径没提到 / 提到没命中 / body 缺失」。

## v0.2.0 — 2026-09-27（老板拍板「开放改仓库代码」）

### 变更

- **目标资产边界扩展**：技能（SKILL.md）→ 技能 + 仓库任意文件。定位三级：
  技能名命中（原 resolveTargetSkill）→ 提案里反引号路径命中仓库文件（新
  `resolveTargetAsset` + `extractRepoPaths`）→ 放弃。仓库清单靠运行时扫描
  （跳 .git/node_modules/dist 等，封顶 3000 文件）。此前 19/20 候选
  `no target skill resolved` 的主因即目标面太窄。
- **commit 默认开**（原默认关）：老板 2026-09-27 拍板最高档「开放改仓库代码」+
  K51「可回滚 > 可审批、kill-switch ≠ 默认关」。落点 = 仓库正本（部署位会被
  install.sh 镜像覆盖，写了白写）。
- **commit 落盘三保险**（新 `commitToRepo`）：denylist（cordis.patch.yml / .git /
  node_modules 绝不碰）+ oldText 必须在目标文件中**恰好出现一次** + preimage 备份
  到 `.agint-preimage/<路径扁平化>-<时间戳>.bak`。git 工作区天然可 diff/checkout
  回滚；每次 commit 发 `evolution.mutation.committed` 事件。
- **repoRoot 解析**：env `AGINT_EVOLUTION_DRIVER_REPO_ROOT` > patch config
  `repoRoot` > null（null ⇒ 只 propose 不落盘）。
- SYSTEM_PROMPT / schema 描述同步：删除"would require code changes → false"
  旧导向（正是挡住代码类提案的另一只手）。

### 测试

T20–T25 新增（路径提取 / 三级定位 / commit 默认开 / repoRoot 优先级 /
commitToRepo 三保险 / repo 目标全链路），T2/T8/T13 断言随默认值翻转更新。
共 27 用例全绿。

---

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
