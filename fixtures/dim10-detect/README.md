# fixtures/dim10-detect — plugin-preflight dim10 验证 fixture

> **本目录是离线测试夹具，不是可挂载插件。**
>
> 目的：验证 proposal `57541772-362f-4aed-bd4b-a598350482a4`（plugin-preflight 加 dim 10「文档-代码公式一致性」advisory 检测）的实际有效性。
>
> 与 `fixtures/mount/` 同款约定——永远不被加载到 runtime。

---

## 目录

```
dim10-detect/
├── README.md           ← 本文件
├── fixture-A-detached/  ← 故意脱节：文档写公式，代码无实现 → dim10 应 WARN
└── fixture-B-implemented/ ← 故意有实现：文档写公式，代码真实现 → dim10 应 OK
```

---

## fixture-A-detached（应被 dim10 报警）

**结构**：
```
fixture-A-detached/
├── manifest.json       ← 最小 manifest（仅含 name + version）
├── README.md           ← 含 HARM 风格加权公式
└── CHANGELOG.md        ← 含 harmWeights 字段引用
```

**README.md 关键内容**：
```md
## HARM 公式

HARM_score = 0.4·Q + 0.6·E
```

**CHANGELOG.md 关键内容**：
```md
## v0.1.0

引入 harmWeights: { Q: 0.4, E: 0.6 }，待 policy 接入
```

**预期 dim10 行为**：
- 扫到 HARM 公式（type=harm）+ harmWeights 字段（type=harmWeights）
- grep `0.4.*Q` + `Q:\s*0.4` → 全仓 0 命中（fixture 自身 lib/ 不算）
- 输出 `[WARN] 文档有公式但 plugins/ 无外部实现`

## fixture-B-implemented（应被 dim10 静默 pass）

**结构**：
```
fixture-B-implemented/
├── manifest.json       ← 最小 manifest
├── README.md           ← 含公式
├── CHANGELOG.md        ← 含权重表
└── lib/
    └── index.js        ← 真实现 computeComposite
```

**README.md 关键内容**：
```md
## score 公式（fixture-B 自身实现验证）

score = 0.5 * metric_a + 0.5 * metric_b
```

**lib/index.js 关键内容**：
```js
// ⚠️ ALLOW-FORMULA-DOC：此公式由 fixture-B 自身实现
function computeComposite({ a, b }) {
  return 0.5 * a + 0.5 * b;
}
```

**预期 dim10 行为**：
- 扫到 composite 公式（type=composite）+ fixture 自身 `lib/index.js` 有实现
- 因 fixture 自身在 pluginDir 里，`excludeDir` 过滤后会标记为"self-impl"
- **真正的 dim10 校验**需要把"self-impl"也算通过——所以输出 `[ OK ] self-impl`

## 验证步骤

```sh
# 1. 跑 fixture-A（应 WARN）
node bin/_verify-dim10.mjs fixtures/dim10-detect/fixture-A-detached

# 2. 跑 fixture-B（应 OK）
node bin/_verify-dim10.mjs fixtures/dim10-detect/fixture-B-implemented

# 3. 跑严格模式（fixture-A 应 exit 1）
node bin/_verify-dim10.mjs fixtures/dim10-detect/fixture-A-detached --strict

# 4. 跑真实 plugin（如 agint-quality-eval）的 HARM schema-only 案例
node bin/_verify-dim10.mjs plugins/agint-quality/agint-quality-eval
```

---

## 版本

- v0.0.1 — 2026-09-09 智进 首版（提案 57541772 验证用）