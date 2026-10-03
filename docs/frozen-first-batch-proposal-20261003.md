# Frozen 首期 10 单元候选提案

> 生成器：`bin/propose-frozen-candidates.mjs`（只读）· 存量 fail 6 个 · 名额 10
> ⛔ 本文件是**提案**不是决定。分配要老板点头，入账要部署后走宿主方法
> `agint.evolution.recordFrozenSet(entry)`（独立进程直写会被 last-write-wins 覆盖）。

## 1. 名额从哪来（算术，不是偏好）

| 约束 | 公式 | 值 | 含义 |
|---|---|---|---|
| H2 | ⌈0.6 × 10⌉ | **6** | Frozen 里至少这么多要新编写 |
| H3 | 6 − ⌈0.6 × 6⌉ = 6 − 4 | **2** | 存量 fail 探针上限 |
| H1 | ⌈0.6 × 6⌉ | **4** | Evolution 侧必须保留的 fail 下限 |
| H4 | 域单元数 ≥ 3 | — | 单元太少的域不得进 Frozen |

> ⚠️ H3 的上限随 fail 数重算。`docs/specs/three-tier-quota.md` 记的是 fail=5 ⇒ cap=2，那是旧快照；当前 fail=6 ⇒ cap=2。本表不读文档常量。

## 2. 存量候选（从现有 123 个里选）

### 2.1 存量 fail 探针 2 个（上限 2）

| unitId | 域 | 类型 | 文件 | 选它的理由 |
|---|---|---|---|---|
| `service-annotations-table-full-throws` | diagnosis | integration | `eval/scenarios/agint-diagnosis.scenario.json` | 已知会失败的探针：进 Frozen 后若它开始通过 = 真的变了 |
| `s12-05-policy-policy-deployed-rolledback-shadow` | event-bus | integration | `eval/scenarios/agint-event-bus-s12-05-policy.scenario.json` | 已知会失败的探针：进 Frozen 后若它开始通过 = 真的变了 |

**被 H4 否掉的 fail 单元**（不是漏选，是该域单元数不够）：

- `cron-default-jobs-registered`（cron）— H4：域 cron 单元数不足，fail 探针也进不了 Frozen

### 2.2 存量 PASS 2 个（补足余额）

> 选法：合格域里**按域占比反比**排序（单元少的域优先），一轮一域一个。
> 原因：quality 域占 46.3%，不压低就会把名额吃掉一半。

| unitId | 域 | 类型 | 文件 |
|---|---|---|---|
| `rules-allow-mv-evolution-log-rotation` | rules | integration | `eval/scenarios/agint-rules-policy-deny.scenario.json` |
| `s12-02-evolution-evaluated-sync-edge` | event-bus | integration | `eval/scenarios/agint-event-bus-s12-02.scenario.json` |

域覆盖：rules · event-bus

## 3. 新编写槽位 6 个（占 6 名额）

> ⛔ 仓库里**新编写的 Frozen 单元当前是 0 个**（123 个全是存量）。
> 所以这里是**槽位**（该往哪个域写、写什么方向），不是已写好的单元。
> 绝不把存量单元标成「新编写」来凑 H2 —— H2 的作用就是防止「用见过的题考自己」。

| 槽位 | 域 | 方向 | 该域现有单元 |
|---|---|---|---|
| `NEW-01` | rules | 为域 rules 新编第 1 个 Frozen 单元（当前该域 5 个存量单元） | 5 |
| `NEW-02` | event-bus | 为域 event-bus 新编第 1 个 Frozen 单元（当前该域 6 个存量单元） | 6 |
| `NEW-03` | install-security | 为域 install-security 新编第 1 个 Frozen 单元（当前该域 6 个存量单元） | 6 |
| `NEW-04` | evolution-memory | 为域 evolution-memory 新编第 1 个 Frozen 单元（当前该域 7 个存量单元） | 7 |
| `NEW-05` | mount | 为域 mount 新编第 1 个 Frozen 单元（当前该域 8 个存量单元） | 8 |
| `NEW-06` | pipeline | 为域 pipeline 新编第 1 个 Frozen 单元（当前该域 8 个存量单元） | 8 |

**每个槽位的验收条件**（与槽位一一对应）：

- **NEW-01**（rules）
  - 必须新增独立的 .scenario.json 单元，⛔ 不得复制现有单元的断言
  - 入库后须重跑 node bin/build-scenario-inventory.mjs 并确认 contentHash 变化条数 = 新增条数
  - labelAuthority 建议标 GOLD（判定基准由人手签核，不靠模型自评）
- **NEW-02**（event-bus）
  - 必须新增独立的 .scenario.json 单元，⛔ 不得复制现有单元的断言
  - 入库后须重跑 node bin/build-scenario-inventory.mjs 并确认 contentHash 变化条数 = 新增条数
  - labelAuthority 建议标 GOLD（判定基准由人手签核，不靠模型自评）
- **NEW-03**（install-security）
  - 必须新增独立的 .scenario.json 单元，⛔ 不得复制现有单元的断言
  - 入库后须重跑 node bin/build-scenario-inventory.mjs 并确认 contentHash 变化条数 = 新增条数
  - labelAuthority 建议标 GOLD（判定基准由人手签核，不靠模型自评）
- **NEW-04**（evolution-memory）
  - 必须新增独立的 .scenario.json 单元，⛔ 不得复制现有单元的断言
  - 入库后须重跑 node bin/build-scenario-inventory.mjs 并确认 contentHash 变化条数 = 新增条数
  - labelAuthority 建议标 GOLD（判定基准由人手签核，不靠模型自评）
- **NEW-05**（mount）
  - 必须新增独立的 .scenario.json 单元，⛔ 不得复制现有单元的断言
  - 入库后须重跑 node bin/build-scenario-inventory.mjs 并确认 contentHash 变化条数 = 新增条数
  - labelAuthority 建议标 GOLD（判定基准由人手签核，不靠模型自评）
- **NEW-06**（pipeline）
  - 必须新增独立的 .scenario.json 单元，⛔ 不得复制现有单元的断言
  - 入库后须重跑 node bin/build-scenario-inventory.mjs 并确认 contentHash 变化条数 = 新增条数
  - labelAuthority 建议标 GOLD（判定基准由人手签核，不靠模型自评）

## 4. H4 否掉的域（要进 Frozen 得先补单元）

| 域 | 现有单元数 | 缺口 | 说明 |
|---|---|---|---|
| cron | 2 | 1 | H4：该域 2 个单元 < 3 ⇒ 不得进 Frozen。要解锁需先给该域新编 1 个单元。 |
| metrics | 2 | 1 | H4：该域 2 个单元 < 3 ⇒ 不得进 Frozen。要解锁需先给该域新编 1 个单元。 |
| dream | 1 | 2 | H4：该域 1 个单元 < 3 ⇒ 不得进 Frozen。要解锁需先给该域新编 2 个单元。 |
| memory | 1 | 2 | H4：该域 1 个单元 < 3 ⇒ 不得进 Frozen。要解锁需先给该域新编 2 个单元。 |

> `dream` 与 `memory` 各只有 1 个单元 —— 这正是 `evaluation-protocol-v1.md` §7 限制 1
> 登记的盲区（这两个域的能力提升无法被 Frozen 检出）。本表把它量化成具体缺口。

## 5. 判据自检（候选方案当场喂回判据层）

| 判据 | 结果 | 依据 |
|---|---|---|
| H1 Evolution 保留 fail ≥ 4 | ✅ | Evolution 层实测保留量 |
| H2 新编写 ≥ 6 | ✅ | 槽位数 6（尚未写成单元） |
| H3 存量 fail 探针 ≤ 2 | ✅ | 实选 2 |
| H4 域单元数 ≥ 3 | ✅ | 合格域 9 个 · 判据层 H4 报错 0 条 |

合计：存量 4 + 新写 6 = **10** / 名额 10 ✅

候选集合的临时聚合 hash：`sha256:a2a7fd9ff4174a81a67e7ba0a76f1d1383c45a9f879b9486b3d4f02d095e08ab`

> ⚠️ 这个 hash 只覆盖**存量部分**。新编写单元入库后 hash 必然变化 —— 那是预期的，不是漂移。

---

## 下一步（按顺序）

1. 老板从上面 10 个候选里点定（存量 4 个 + 新写 6 个的方向）
2. 新写 6 个场景文件 → 重跑 `build-scenario-inventory.mjs` 确认 contentHash 变化数 = 6
3. 把 10 个单元的 `visibility` 改成 `FROZEN` 写进 sidecar `eval/tiers/agint-tiering.json`
4. 跑 `node bin/build-scenario-inventory.mjs --check` 确认判据全绿（含 H5 首版无基线）
5. 部署 + 重启后走 `agint.evolution.recordFrozenSet(entry)` 入账，并用 `node bin/anchor-frozen-set.mjs` 对账

*只读脚本：它不写 sidecar、不写清单、不入账。第 3 步起需要人操作。*
