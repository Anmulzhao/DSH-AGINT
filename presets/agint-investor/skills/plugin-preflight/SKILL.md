---
name: plugin-preflight
description: "新增 / 修改 agint-* 插件挂到 cordis.patch.yml 前的强制准入工作流。10 分钟搞定，比挂上去再崩 30 分钟排障便宜十倍。涉及任何 plugin 源码变更、新插件创建、cordis.patch.yml 新增 - id 行时调用。子 preset 版本，与母 preset plugin-preflight 内容同步。"
---

# 插件准入预检（Plugin Preflight，子 preset 版本）

内容与母 preset `plugin-preflight` 同源（避免在 3 个 preset 重复维护）。如果两边出现差异，**以母 preset 为准**，在这里 PR 时同步母 preset。

调用入口：

```sh
bin/plugin-check.sh --all
node bin/_verify-dim9.mjs plugins/agint-<name>/lib/index.js
bin/safe-update.sh smoke && bin/safe-update.sh mount-patch
```

详见母 preset `presets/agint/skills/plugin-preflight/SKILL.md`。
