# agint-wiki

> 知识库：markdown 文件 + 域过滤 + 健康检查。

## 职责

- 提供 `agint.wiki` host Service
- 提供 `wiki_*` model 工具（read/write/search/list/lint）
- 落到 `$AGINT_HOME/wiki/` 目录

## 存储

markdown 文件 + frontmatter。每个文件路径即 ID。

## 写入约定

- **principles（教训/决策/偏好）不进 wiki**——它们进 `agint.memory`
- **knowledge（研究/参考/分析）才进 wiki**
- **D-QAF 评估报告进入 wiki**（v0.2 起）—— `domain: quality` 域
- **evolution-framework 文档同步到 wiki**（v0.2 起）—— `domain: AGINT` 域
- 文件 frontmatter 含域（`domain:`）便于过滤
- 引用外部源：cite with file+line

## 模型接口

- `wiki_search(query, domain?)` 关键词命中
- `wiki_read(path)` 读全文（path 相对 wiki 根）
- `wiki_write(path, content)` 写/覆盖（frontmatter 必填）
- `wiki_list(domain?)` 列出全部
- `wiki_lint` 健康检查（断链 / 矛盾标记 / orphan）

## 与其他插件的关系

- **`agint.metrics`**：`wiki.brokenLinks` / `wiki.orphans` 指标从 lint 结果采集
- **`agint.dream`**：梦境日记与复盘报告都写 wiki 同介质
- **`agint.evolve`**：复盘报告存 `reviews/`，但生成后调用 `agint_wiki` 同步索引
- **`agint.quality.contract`**（v0.2）：评估报告归 `domain: quality`

## 文件

```
lib/index.js   Cordis apply()：注册 agint.wiki Service（fs + search）
lib/tools.js   wiki_* model 工具
```
