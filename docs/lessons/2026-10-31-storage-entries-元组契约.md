# K：`table.entries()` 是 `[key, value]` 元组迭代器，不是对象流（2026-10-31）

> 一个 bug 让 mutator 的**唯一约束 / 幂等 / 状态机 / 回滚**四件事同时失效三个月，
> 而所有测试一直是绿的、所有门禁一直是绿的。

## 症状（都不是崩溃）

- `agint_mutator.proposals` 8 条**全部停在 `PENDING`**，而 `commits` 表里 8 条一一对应、全 `AUTO_DEPLOY`。
- 同一 `atomicScope='prompt'` 的 8 条 PENDING 并存 —— 声称的 `uniq_atomicScope_pending` 从不生效。
- `rollback({commitId})` 对**表里确实存在**的 commit 抛「在 commits 表里查不到」。
- 没有任何异常、没有 `accounting-failed` 事件、没有失败日志。

## 根因

`ctx.storageDomain` 的 `table.entries()` 返回
`[...records.entries()][Symbol.iterator]()`（`dsh-storage-domain` 0.2.1-rc.3，
`KvTableImpl.entries()`，lib/index.js:245）——**元素是 `[key, value]` 元组**。

mutator 6 处把它当扁平对象流：

```js
tP.entries().find((e) => e.id === proposalId)   // e 是 ['<id>', {...}] ⇒ e.id 恒 undefined
```

在 Node 18 这会抛 `TypeError: entries(...).find is not a function`，**立刻暴露**。
但 Node 22 有 **Iterator Helpers**：`Iterator.prototype.find / some / filter / map`
都存在 ⇒ 代码**能跑、不报错、静默返回「没找到」**。

所以这是一个「**运行时版本升级把崩溃换成了静默**」的案例：同样的代码在旧 Node 上是红的，
在新 Node 上是绿的 —— 而绿的是错的。

## 为什么三个月没人发现

8 个测试文件的假 ctx 都让 `entries()` 返回**扁平 `{id, ...v}` 数组**：

```js
entries: () => Array.from(s, ([id, v]) => ({ id, ...v }))   // ❌ 生产里没有这种形状
```

被测代码与 mock 用了**同一个错误假设**，于是测试永远绿。这是 K115
「mock 必须复刻真实契约，否则字段名写错也照样绿」的同一族，只是错的是**数据结构形状**
而不是字段名 —— 更难看出来，因为它连类型都不报。

## 判据（下次怎么防）

1. **写 mock 前先读实现的返回语句**，不读调用方的期待。`entries()` 这类基础契约，
   一句话就能确认：去 `node_modules/@deepseek-ai/dsh-storage-domain` 看 `KvTableImpl`。
2. **mock 里的简化必须被标注并解释**。写 `Array.from(...)/flatten` 时要问：
   「真实实现会不会返回别的形状？我 flatten 掉的东西，正是被测代码可能依赖的东西吗？」
3. **跨插件读表要过一层 helper**（本仓已收敛为 `rowsOf(t)`）。散落的
   `t.entries().find(...)` 是这类错误的温床 —— 每多一处，就多一个忘记解包的机会。
4. **门禁要能看出「方法从没被调用」**（`check-wiring` 查 A2 DEAD_METHOD）。
   这个 bug 与 `mutator.commit` 零调用是同一片「以为通电实际没人跑」的地：光看
   「有人提到这个名字」永远不够。

## 修复清单（mutator 0.6.12）

| 位置 | 原来 | 现在 |
|---|---|---|
| `propose` 唯一约束 | `t.entries()` | `rowsOf(t)` |
| `commit()` 读 proposal | `tP.entries().find` | `rowsOf(tP).find` |
| `recordExternalCommit` 幂等 | `tC.entries().some` | `rowsOf(tC).some` |
| `recordExternalCommit` 状态推进 | `tP.entries().find` | `rowsOf(tP).find` |
| `rollback()` 查 commit | `tC.entries().find` | `rowsOf(tC).find` |
| `rollback()` 查 proposal | `tP.entries().find` | `rowsOf(tP).find` |

配套：8 个测试文件 mock 改为元组迭代器；`size` 从构造快照改为 getter；
新增「记账 → 回滚后 proposal 终态必须是 `ROLLED_BACK`」断言（一次推进到 COMMITTED、
再一次到 ROLLED_BACK ⇒ 证明真的被推进过，而不是巧合）。

**存量数据必须一起处理**：8 条 PENDING 已按 `commit.policyDecision` 回填为 `COMMITTED`
（2026-10-31 重启生效）。不回填的话，唯一约束修好之后第一次 `propose` 就会被僵尸挡住 ——
**修复本身会把系统堵死**，这是「修 bug 必须同时看存量数据」的一次实例。
