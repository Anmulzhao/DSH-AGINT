# AGINT 桌宠 fork：许可与分发策略

- 日期：2026-10-04
- 状态：**已定案**（老板 2026-10-04 拍板 1-3 条；2026-10-05 补充第 4 条的执行方式）
- 关联提案：`dbe682e8`（v4 架构，复用 dsh-pet）
- 定案结果：fork 已建立为 `Anmulzhao/agint-pet`，`assets/agint/` 57 帧已入库

## 结论

1. 走 GitHub **fork**，不走「下载后重新上传」。✅ 已执行
2. fork 仓的 `LICENSE` **保持 Apache-2.0 不动**。✅ 已执行
3. AGINT 自己新写的文件**另加版权声明与条款**。✅ 已执行（`LICENSE-AGINT.md` / `LICENSE-MIT-AGINT.md` / `NOTICE`）
4. 分发前**剔除 4 个受限资产**。⚠️ **2026-10-05 老板裁定：先不删。**
   改为**靠 `package.json#files` 白名单挡住**（见第四节），删目录这步延后到真要对外分发时再做。

## 0. 补记：白名单机制（2026-10-05 实测）

原方案是「删目录」。实测发现**更稳的一层**：`package.json#files` 是 npm 的打包白名单，
只列了 6 个 assets（5 个干净资产 + `assets/agint`）。**4 个受限资产本来就不在白名单里**
⇒ `npm publish` 不会带它们。

| 路径 | 会不会带受限资产 |
|---|---|
| `npm publish` / `npm pack` | ✅ 不会（白名单过滤） |
| `git archive` / 手工 tar / 整目录拷贝 | ❌ **会**（无过滤） |

**所以「先不删」在打包路径上已经安全，风险只剩「整目录拷贝」这一条人工路径。**
这也是本条从「必做」降级为「对外分发前再做」的技术依据。

⚠️ 同一机制反过来咬过一次：2026-10-05 帧入库时**忘了把 `assets/agint` 加进白名单**，
57 帧在仓库里但 `npm pack` 会全漏掉。已补。同一个白名单既是安全网也是**必须显式维护的清单**。

## 一、fork 还是重新上传

### 选 fork

1. 保留上游历史 = 派生的自证。合规争议时这是证据。
2. GitHub fork 网络自动显示 `forked from zhu1090093659/dsh-pet`，来源一眼可查。
3. 上游在动。父仓 `dsh-web-ui` HEAD 提交时间是 2026-10-04 17:08，dsh-pet 是 2026-10-03 01:13。`git fetch upstream` + `git rebase upstream/dev` 是现成流程。
4. 上游修 bug 时能 cherry-pick，不用手抄。

### 什么时候才选「下载后重新上传」

1. 决定彻底切断血缘，不再跟上游同步。
2. 仓库体积是硬约束。
3. 打算重写而不是派生。

### 必须说清的一句

**重新上传不解除 Apache-2.0 义务。** 你复制了代码就得履行 §4。清空 git 历史不等于清空版权。`LICENSE` 换成 MIT 一样违规。

### 体积数据

| 部分 | 大小 |
|---|---|
| `.git` | 216.7 MB |
| 工作区 | 211.9 MB |
| 合计 | 428.6 MB |

fork 保留全部 428.6 MB。重新上传的新仓只有工作区，省 216.7 MB。剔 4 个受限资产再省 72.8 MB。

## 二、许可证选择

### Apache-2.0 §4 最后一段（`dsh-pet/LICENSE` 第 124-129 行）

> You may add Your own copyright statement to your modifications, and may provide additional or different license terms and conditions for use, reproduction, or distribution of Your modifications, or for any Derivative Works thereof as a whole, **provided Your use, reproduction, and distribution of the Work otherwise complies with the conditions stated in this License.**

允许你另加条款，条件是仍然履行 §4(a)(b)(c)(d)。换不掉的是这四条。

| 选项 | 能不能做 |
|---|---|
| 整个 fork 标 MIT | 不能 |
| `Apache-2.0 OR MIT` 整体双许可 | 未验证，见第五节 |
| 保持 Apache-2.0 | 能，最省事 |
| 上游代码 Apache-2.0 + 自己的新文件另加条款 | 能，§4 明确允许 |

## 三、必须履行的四条

1. §4(a)：给接收者一份 Apache-2.0 许可证全文。`LICENSE` 不动。
2. §4(b)：改过的文件加显著变更声明。文件头写。
3. §4(c)：保留上游全部 copyright / patent / trademark / attribution 声明。
4. §4(d)：上游没有标准 `NOTICE` 文件，但有 `THIRD_PARTY_NOTICES.md`（129 行）。原样带走。

## 四、受限资产清单（实测 pet.json 的 license 字段）

仓库根的 `LICENSE` **覆盖不了**这些。各 `pet.json` 自带条款。

| 目录 | pet.json 声明 | 附加约束 | 大小 |
|---|---|---|---|
| `assets/doro/` | MIT | 角色归 SHIFT UP，**限个人非商业使用，不得销售或商用** | 55.5 MB |
| `assets/miku/` | MIT | 角色权利归 Crypton Future Media，**受 Piapro Character License 约束** | 12.9 MB |
| `assets/starry-doll/` | **CC-BY-NC-SA-4.0** | 非商业 + 相同方式共享 | 0.8 MB |
| `assets/long-niang/` | **CC-BY-NC-SA-4.0** | 非商业 + 相同方式共享 | 3.6 MB |

合计 72.8 MB。

### 干净的资产（可留）

| 目录 | pet.json 声明 | 大小 |
|---|---|---|
| `assets/jyn/` | MIT | 113.9 MB |
| `assets/jyn-foxtail/` | MIT | 14.9 MB |
| `assets/ouo-neko/` | MIT | 2.9 MB |
| `assets/whale-refined/` | MIT | 2.2 MB |
| `assets/whale/` | BSD-3-Clause | 2.0 MB |
| `assets/blue-throated-bee-eater/` | Apache-2.0 | 1.8 MB |
| `assets/decorations/whale/` | MIT | < 0.1 MB |

### 一处上游文档过时

`README.zh.md` 第 230 行称 starry-doll「仅经创意工坊分发，不随包内置」。实测 `assets/starry-doll/` 目录存在且带 `pet.json`，`license: CC-BY-NC-SA-4.0`。上游 README 该说法已过时。同一张表也漏了 `long-niang` 和 `whale-refined`。

## 五、不确定的部分

1. **我不是律师。** 本文是技术面判断，不是法律意见。公开发布前请找律师过。
2. **`Apache-2.0 OR MIT` 整体双许可**能不能用，我没有确定答案。理论上有人这么标，但 §4 条件句写得很硬，我不知道司法实践怎么判。要用先问律师。
3. **Live2D 是合同义务不是许可问题。** `README.zh.md` 第 149 行：公开发布基于可加载用户模型的衍生作品时，可能不论规模都要与 Live2D 签发行许可。走纯 sprite 路线无此坑。
4. **商标不在授权范围。** Apache-2.0 §6 不授予商标权。dsh-pet 的名字和 DeepSeek 的名字都不能用。

## 六、执行清单

**已执行（2026-10-04/05）**

1. ✅ 在 GitHub 上 fork `zhu1090093659/dsh-pet` → `Anmulzhao/agint-pet`。
2. ✅ `git remote rename origin upstream` + `git remote add origin <fork>`（`origin` = fork，`upstream` = 上游）。
3. ✅ 推送保护钩子：见第七节（此项未做，记为遗留）。
4. ⏸ **删 4 个受限资产** —— **2026-10-05 老板裁定先不删**，改由 `package.json#files` 白名单挡住。
   真正对外分发时再做，届时按下面第 4-1 条执行。
5. ✅ 检查代码引用 —— `git grep -iE "doro|miku|starry-doll|long-niang" src/ contracts/ scripts/` 命中 0，
   无需清理（这 4 个只存在于 `assets/`，注册表不硬编码它们）。
6. ✅ `LICENSE` 保持 Apache-2.0 不动。
7. ✅ `THIRD_PARTY_NOTICES.md` 保留原样（因为没删资产，无需标注「已移除」）。
8. ✅ 新增 `LICENSE-AGINT.md` + `LICENSE-MIT-AGINT.md` + `NOTICE`。
9. ✅ 改过的上游文件加变更声明（`src/service.ts` 的 #1762 修复是**上游自己的**，非我们改动）。
10. ⏸ README 顶部声明 —— 待做（等真要对外分发时一起写）。

**4-1. 将来真要删时的执行步骤**（老板裁定延后，非当前必做）

```sh
rm -rf assets/doro assets/miku assets/starry-doll assets/long-niang
node scripts/dsh-pet validate assets/agint   # 复验保留资产完好
git grep -iE "doro|miku|starry-doll|long-niang" -- src/ contracts/ scripts/   # 期望 0 命中
```

删完还要同步改 `package.json#files`（当前白名单本就不含这 4 个，**故此步实际是空操作**）。

## 七、验证方法

1. ✅ `node scripts/dsh-pet validate assets/agint` → `valid: agint (renderer frames2d)`。
2. ✅ 宿主实测：设置「宠物」分区可选中，`~/.dsh/pet.json` 为 `petId: agint` / `skins.agint: healthy`。
3. ✅ `git grep -iE "doro|miku|starry-doll|long-niang" -- src/ contracts/ scripts/` 命中 0。
4. ✅ 打包白名单核对：`package.json#files` 的 assets 列表 = 5 干净资产 + `assets/agint`，
   **4 个受限资产均不在内**（2026-10-05 实测）。
5. ✅ 远端回读：`git clone --depth 1 Anmulzhao/agint-pet` → 61 文件与本地逐字节一致，
   克隆副本上跑 `validate` 仍 `valid: agint`。
