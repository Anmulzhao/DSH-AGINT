# agint-search-tools

跨 `agint.memory`(长期记忆/原则)和 `agint.wiki`(知识库)的统一搜索。

## 状态

**第 1 版,等老板 review。** 没有装到任何 preset,没有跑过。

## 流程来源

按和老板对齐的"动态试跑 → 决定是否固化"流程:
1. ✅ 用 `cordis_define` 走动态试跑 — **本会话工具集没有 `cordis_define`**,跳过
2. ✅ 摸清 host service 接口 — 已通过 subagent 报告交叉验证
3. ⏳ **当前步骤**: 写到独立目录供 review
4. ⬜ 下一步(待老板拍板): 挂到 `agint` preset 的 `agent.cordis.yml` 末尾 + 重启 DSH

## 文件

```
D:\DSH\plugins\agint-search-tools\
├── package.json          # 名字 + 版本 + main = lib/tools.js
├── lib/
│   └── tools.js          # apply(ctx): 注册 agint_search 工具
└── README.md             # 本文件
```

## 工具签名

**`agint_search`** — 跨 memory + wiki 统一搜索。

参数:
- `query: string` (必填) — 关键词
- `sources?: ('memory'|'wiki')[]` — 限定来源,默认两者都搜
- `type?: 'lesson'|'decision'|'preference'|'pattern'` — 仅 memory:按类型过滤
- `domain?: string` — 仅 wiki:按域前缀过滤(如 `"AGINT/"`)
- `limit?: number` — 最大返回数(默认 20)

返回:
```js
{
  hits: [
    { source: 'memory', id, title, snippet, type, confidence, ... },
    { source: 'wiki',   path, line, title, snippet, ... }
  ],
  counts: { memory, wiki }
}
```

## 实现要点

- `inject: ['tools', 'agint.memory', 'agint.wiki']` — 声明硬依赖
- 只注册工具,不发 service — 与 agint-memory-tools / agint-wiki-tools 一致
- **不需要 isolate realm**(consumer-only)
- 排序:memory 先(已按 effectiveConfidence 排),wiki 后(按路径排),最后按 `limit` 截断
- **没有去重、没有 hit-scoring、没有 highlighting** — 这些是后续迭代

## 与已有工具的关系

| 工具 | 覆盖 |
|---|---|
| `memory_search` | 仅 memory,按 effectiveConfidence |
| `wiki_search` | 仅 wiki,按路径 |
| **`agint_search`(本工具)** | 两者都搜,合并返回 |

`agint_search` 是合并入口,不替代 `memory_search` / `wiki_search`(那些工具的语义更细)。

## 已知限制

1. **没在真机跑过** — 因为本会话没有 `cordis_define` / `cordis_run`,签名靠 subagent 报告 + 源码核对,可能有字段遗漏
2. **memory.search 是子串匹配** — 不是 FTS/embedding
3. **wiki.search 不带相关性** — 按 path 排

## 安装(老板拍板后做)

挂到 `agint` preset:

```yaml
# ── 智进 cross-domain search tool ──────────────────────────────────────────
# Consumes host `agint.memory` + `agint.wiki`, publishes nothing.
# Inserts above the last tool row, before/after agint-wiki-tools as preferred.
- id: agint-search-tools
  name: D:\DSH\plugins\agint-search-tools\lib\tools.js
```

然后 `dsh restart` 验证。

## 验证步骤(安装后)

1. 在 agint session 里调 `agint_search { query: "preset", sources: ["memory", "wiki"] }`
2. 期望:返回 memory + wiki 两边的命中,counts 正确
3. 边界:搜不存在关键词 → `hits: []`
4. 卸载验证:`dsh restart` 一次不挂此 row → 工具消失,plugin error 清理

## 回滚

- 把上面那段 yml 注释掉或删除
- `dsh restart`
- 目录保留(下次还要用),不需要删 `D:\DSH\plugins\agint-search-tools\`