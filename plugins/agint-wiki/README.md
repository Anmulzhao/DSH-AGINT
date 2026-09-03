# agint-wiki

智进 (agint) wiki 知识库：host service `agint.wiki`（基于 markdown 文件的读写）+ preset-scoped tools（read/write/search/list/lint）。

知识层 vs 原则层：

- **wiki（这里）**：领域知识、行业研究、技术参考、复盘素材 —— 文件即媒介，可审计、可 diff
- **memory（agint-memory）**：教训/决策/偏好/规律 —— 走 `memory_write`，结构化、跨 session 高优召回

## 提供

- **`agint.wiki`** — host service：`read(path) / write(path, content) / remove(path) / list(domain?) / search(query, opts?) / lint()`
- **tools** — `wiki_read / wiki_write / wiki_search / wiki_list / wiki_lint`（在 agint preset 装载）

## 配置

`profile-patches/web/cordis.patch.yml` 里的 row：

```yaml
- id: agint-wiki
  name: ./plugins/agint-wiki/lib/index.js
  config:
    root: !!js (process.env.AGINT_HOME || (process.env.HOME + '/projects/AGINT')) + '/wiki'
```

`root` 是 wiki 的根目录；所有路径相对 `root`，必须 `.md`，不可越界（`../` 拒绝）。

## 路径安全

`clean()` 把传入路径 `resolve(root, trimmed)` 后规范化比较（Windows `\` ↔ POSIX `/`），比对形式是 `normAbs.startsWith(normRoot + '/')`。**仍拒 `../`**：

- ✅ `hello.md` → `root/hello.md`
- ✅ `行业/光伏.md` → `root/行业/光伏.md`
- ✅ `/leading-slash.md` → leading `/` 被剥掉
- ❌ `../escape.md` → 抛 `path escapes root`
- ❌ `../../etc/passwd.md` → 抛 `path escapes root`

## 测试

```sh
node plugins/agint-wiki/test/smoke.mjs   # 期望 exit 0
```

覆盖：import / apply / write-read round-trip / search / lint / 路径越界负向用例。