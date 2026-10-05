# 两仓关系：DSH-AGINT 与 agint-pet

- 日期：2026-10-05
- 状态：可执行
- 适用范围：AGINT 桌宠（`pets/agint/`，A+回环形态）
- 关联：主仓 `docs/brand/agint-character-spec.md`（形象规范）、
  pet 仓 `docs/AGINT/桌宠方案.md`（实施方案）

本文件回答一个问题：**桌宠做成独立仓，同时为 AGINT 专用，两个仓怎么划界、怎么同步、什么坏了归谁。**

## 1. 分仓理由（为什么是两个仓，不是三个）

一句话：**AGINT 能力与桌宠素材的变更节奏不同，混在一起会互相拖累。**

| | DSH-AGINT（主仓） | agint-pet（pet 仓） |
|---|---|---|
| 是什么 | AGINT 能力本体：34 个插件、cron、eval 体系、L0 门禁 | dsh-pet 的 fork：桌宠插件 + 全部形象素材 |
| 谁在读 | 只有 dsh 宿主 | 只有 dsh 宿主 + 想装桌宠的人 |
| 变更节奏 | 每天都在改 | 一个形象定稿才动一次 |
| 外部依赖 | 无 | **上游 `zhu1090093659/dsh-pet`（必须持续 rebase）** |
| 是否允许改上游代码 | — | **零改动**（`src/` `contracts/` `scripts/` 与上游逐字节相同） |

**关键理由是最后一行。** 本 fork 的存在意义是**当上游同步的缓冲区**：
上游修 bug 要能直接 `git fetch upstream` 加重基，所以 `src/` 一行都不能碰。
AGINT 逻辑一旦混进 `src/`，每次重基都要人工区分上游文件和 AGINT 文件——那会让同步从「一条命令」变成「一次考古」。

## 2. 职责边界：谁放什么

判据一句话：**会随上游变的放 pet 仓其余放主仓。**

| 资产 | 归属 | 位置 |
|---|---|---|
| 桌宠插件本体（`src/` `contracts/` `scripts/`） | pet 仓（逐字节等于上游） | `Anmulzhao/agint-pet` |
| 桌宠形象素材（帧 + `pet.json`） | pet 仓 | `Anmulzhao/agint-pet/assets/agint/` |
| 帧生成器 | 主仓 | `DSH-AGINT/tools/agint-pet/` |
| 形象规范（几何出处、行号实证） | 主仓 | `DSH-AGINT/docs/brand/agint-character-spec.md` |
| 状态源插件（推 `announce` / `setSkin`） | 主仓 | `DSH-AGINT/plugins/agint-mascot/` |
| 品牌母版 svg | 主仓 | `DSH-AGINT/docs/assets/brand/agint-brand-icon.svg` |

**素材在 pet 仓、生成器在主仓**是刻意的：生成器是 AGINT 的资产（它含品牌几何与 12 条断言），
帧是产物。产物随消费渠道走，工具随所有权走。

## 3. 单向数据流

```
DSH-AGINT/tools/agint-pet/build.mjs
        │  运行（人执行，不是运行时）
        ▼
   57 张 PNG + pet.json
        │  node scripts/dsh-pet.cjs install  或  cp -r
        ▼
~/.dsh/pets/agint/          ← 安装位。宿主唯一真正读的地方
        │  @linxin666/dsh-pet 0.4.4 读取渲染
        ▼
    屏幕上的桌宠
```

⛔ **仓库 ≠ 安装位。** 东西在 GitHub 上不等于宿主看得到。
帧要生效只有一条路：进 `~/.dsh/pets/<id>/`。
宿主读帧是**从磁盘直读 + `cache-control: no-cache`** ⇒ 装完刷新页面即生效，**不必重启 dsh**。

⛔ **宿主跑的宠物插件既不是本仓也不是主仓**，是 npm 官方包
`@linxin666/dsh-pet` 0.4.4（装在 `~/.dsh/profiles/web/node_modules/`，被
`@linxin666/dsh-web-all@0.4.4` 钉死）。**pet 仓的 fork 当前对宿主零贡献**，
它的价值是①素材可分发 ②当上游同步的缓冲区。

## 4. 跨仓契约：AGINT 依赖 pet 的四个面

AGINT 只依赖 pet 的 **4 个面**，全部有行号实证。**pet 改这四处，主仓要跟着改。**

| # | 面 | 位置 | AGINT 侧谁在用 | 破坏后的症状 |
|---|---|---|---|---|
| 1 | 服务名 `ctx.pet` | `src/index.ts:117` | `plugins/agint-mascot/lib/index.js` | 取不到服务，公告与皮肤静默不推 |
| 2 | `pet.announce(payload)` | `src/service.ts:380` | `lib/announce.js` 的 `toAnnouncePayload()` | 气泡不出 |
| 3 | `pet.setSkin(id)` | `src/service.ts:780` | `lib/index.js` 切皮肤 | 皮肤停在旧值 |
| 4 | 清单契约 `frames2d.skins[]` | `contracts/pet-manifest-v2.schema.json:323` | `tools/agint-pet/check.mjs` 跨仓断言 | **宿主回 `unknown-skin`、皮肤静默不换、零日志** |

### 面 4 的防御：跨仓断言

`check.mjs` 第 9 条**直接 import 主仓 mascot 插件的 `skinIdForHealth()`**，
然后要求「插件能请求的每个 skin id，清单必须声明」。这条断言的意义：

- 插件加了新皮肤而清单没加 ⇒ **构建期变红**，不会漏到宿主。
- 反向也成立：清单删了皮肤而插件还要 ⇒ 同样变红。

**这是两个仓之间唯一自动化的耦合检查。** 其余三个面目前靠行号实证（人工核），
上游大版本更新时**必须重核**这四处。

## 5. 同步方向

| 方向 | 频率 | 怎么做 |
|---|---|---|
| pet 仓 → 主仓 | 上游每次发新版 | 重核 §4 的 4 个面行号；核 `src/` 是否仍零改动 |
| 主仓 → pet 仓 | 生成器或规范变了 | 重跑 `build.mjs --verify` → 重出帧 → `install` → 复验字节 |

⛔ **主仓没有 `package.json` 依赖 pet 仓**，两边不存在包级依赖。
唯一双向引用是文档：`agint-character-spec.md` 引 pet 仓源码行号（21 处），
pet 仓 `assets/agint/README` 引主仓的生成器与规范（4 处）。
**文档引用腐坏的风险靠定期人工重核，不靠工具。**

## 6. 归属判据：出问题时归谁

| 症状 | 归 | 查哪 |
|---|---|---|
| 桌宠不出现 / 列表里没有 | pet 仓（安装位） | `~/.dsh/pets/agint/` 是否存在 + `dsh-pet validate` |
| 出现了但不动 / 轨道错 | pet 仓（素材） | 帧字节 vs 发布位；`pet.json` 的 `phases` |
| 气泡不出 / 皮肤不换 | 主仓（mascot 插件） | `mascot_status` 的 `lastPush` / `lastSkinPush`；`ctx.pet` 面是否变 |
| 皮肤换了但状态不对 | 两边（映射错） | `skinIdForHealth()` 的分数阈值 vs 探针实际返回 |
| 改了几何但帧没变 | 主仓（生成器） | `build.mjs --verify` 是否还过 |
| 上游升不动 / rebase 冲突 | pet 仓 | `git fetch upstream` + 看重基冲突面 |

## 7. 已定案的三条纪律

1. **pet 仓 `src/` 零改动。** AGINT 逻辑一律做成主仓的独立插件，跨插件调
   `ctx.pet.*`。要改插件行为时先问：上游能不能改？不能则放主仓。
2. **`assets/agint` 必须写进 `package.json#files` 白名单。** 该白名单是
   npm 打包的唯一闸门：它挡住 4 个受限资产（`doro` / `miku` / `starry-doll` /
   `long-niang`，共 76 MB）不外流，**但同时也是「必须显式维护的清单」——
   漏加就把自己的资产漏掉**。2026-10-05 踩过一次：`assets/agint` 未加白名单，
   57 帧在仓库里而 `npm pack` 会全漏。
3. **形与码分仓，产物与工具分仓。** 帧（产物）随消费渠道走，生成器与规范
   （工具与依据）随所有权走。改几何只动主仓，出帧只动 pet 仓的成品。

## 8. 遗留未验证

1. **上游 README 与本机实测冲突。** 上游写「注册表在宿主启动时构建一次，
   改宠物后要重启 `dsh web` 生效」；本机 2026-10-05 实测帧从磁盘直读、
   刷新即生效（57/57 字节一致，未重启）。**以实测为准**，但冲突未解释——
   可能 `pet.json` 走缓存而帧不走。别人 clone 后若看不到新宠物，先重启兜底。
2. **`/api/pet/pets` 的 `tracks` 字段不可信。** 它给所有 pet（含与 AGINT 无关的）
   返回同一份 9 轨默认清单。判「宿主加载了哪版」要用 `/pet/<id>/pet.json`
   + 逐帧字节比对。
3. **宿主 dsh-pet 落后于上游。** 宿主 0.4.4（发布 2026-09-29）缺上游
   #1762 修复（`bddc3b8`，2026-09-30）。npm 上暂无新版可升，且它被
   `dsh-web-all@0.4.4` 钉死。症状：用总开关隐藏桌宠后开关不可逆。
