---
name: data-analysis-ops
description: 新能源生产运维数据分析的执行规范：从零散数据文件到可复现结论的完整流程 —— 环境与工具链现状（python3/numpy/matplotlib/xlsxwriter/python-docx 可用，pandas 与 openpyxl 未装，无 pandoc/libreoffice）、数据获取与留痕、清洗与质量校验规则、统计口径与单位陷阱、分析脚本的组织与命名、结果输出格式（CSV/XLSX/图表）、可复现性要求、结论的呈现与自查清单。任务涉及运行数据分析脚本、处理监控/发电量/告警数据文件、生成图表、导出报表、批量计算指标时自动加载。
tools:
  - bash
  - read
  - write
  - edit
  - glob
  - grep
triggers:
  - "跑数据分析脚本/算历史指标/批量计算"
  - "处理 CSV/XLSX/监控数据文件"
  - "生成图表、导出报表、数据清洗"
  - "数据质量校验、缺失值处理"
related_skills:
  - newenergy-ops-kpi
  - root-cause-attribution
  - ops-doc-writing
---

# 数据分析执行规范

> 智进·生产运维 专属 skill。**分析必须可复现、口径可追溯** —— 老板要在下周复核时能重跑出同样的数。

---

## 1. 工具链现状（2026-09-30 实测，改动后需重新核实）

| 工具 | 状态 | 用途 |
|---|---|---|
| `python3` | ✅ 3.8.10 | 分析主语言。**注意 3.8：无 `match` 语句、无 `X \| Y` 类型联合** |
| `numpy` | ✅ 1.24.4 | 数值计算、时序聚合 |
| `matplotlib` | ✅ 3.7.5 | 图表（PNG） |
| `xlsxwriter` | ✅ 3.2.9 | **写** XLSX（不能读） |
| `docx` (python-docx) | ✅ 1.1.2 | 生成 Word 文档 |
| `pandas` | ❌ 未装 | 便捷 DataFrame 操作 |
| `openpyxl` | ❌ 未装 | **读** XLSX 的必需库 |
| `pandoc` / `libreoffice` | ❌ 未装 | 格式转换、docx→pdf |

**三个直接后果**（别踩）：

1. **读 .xlsx 需要先装 openpyxl**；`xlsxwriter` 只能写不能读。装包属于改动运行环境，**先问老板再装**。
   ```sh
   # 需要老板确认后执行
   pip3 install openpyxl          # 读 xlsx
   pip3 install pandas            # DataFrame（openpyxl 会被一并装上）
   ```
2. **没有 pandas 也能做**：CSV 用标准库 `csv` 读取，转 `numpy` 数组做聚合即可。数据量在千万行以内这样够用。
3. **不能做格式转换**：docx → pdf / xlsx → csv 没有现成工具。转格式请用 Python 手写或找老板要工具。

**汇报纪律**：交付分析结论时，如果结论依赖了某个缺失的库，**明确说明"当前环境缺 ××，我用了 ×× 替代方案，结论口径为 ××"**。不要让老板以为环境里什么都有。

---

## 2. 数据获取：先找，再拷，再留痕

### 2.1 定位数据源

优先顺序：**工作目录内的原始文件** → 老板指定的路径 → 需要外部导出（此时先问怎么取）。

用 `glob` / `grep` 找文件，不要猜路径。找到后先看前几行确认结构，**不要直接假设列名**。

### 2.2 留痕（硬要求）

**原始数据一律只读，永不原地修改。**

工作目录约定：

```
analysis/
  YYYY-MM-DD-主题/
    raw/        ← 原始数据副本（只读，改权限或另存）
    scripts/    ← 分析脚本
    out/        ← 结果：CSV / XLSX / PNG
    README.md   ← 这次分析做了什么：数据来源、口径、结论、遗留问题
```

**为什么强制留痕**：下周老板问"上个月那个数怎么算的"，你要能在 30 秒内指出来源和脚本。没有 `analysis/` 目录的分析等于没做过。

---

## 3. 数据清洗与质量校验

### 3.1 必做校验（顺序固定）

1. **行数与时间范围**：覆盖的时间段是否与需求一致？缺哪些天？
2. **缺失值**：数量、分布（集中在某天？还是全天零星？）。
3. **重复记录**：时间戳重复。
4. **数值范围**：是否有负数（发电量）、超物理上限（效率 >1）、量纲错误（kW 当 kWh）。
5. **采样频率**：是否均匀？采样间隔变化会导致累加口径变化。
6. **跨源一致性**：两个数据源的同期值对得上吗？对不上先解决，别急着算。

### 3.2 缺失值处理规则（不许随手填）

| 场景 | 处理 | 理由 |
|---|---|---|
| 停机时段发电为 0 | **保留为 0** | 真实业务事实 |
| 采集点丢失 | **标记为缺失，另行统计**，不填 0 | 填 0 会虚增损失 |
| 短时异常尖峰 | 标记 + 单独说明，**不静默剔除** | 静默剔除是数据造假 |
| 长时段整段缺失 | 该时段**从样本中剔除并明确记录剔除范围** | 但**分母口径必须前后一致**（见 `newenergy-ops-kpi` §4.6） |
| 辐照/风速缺失 | 停用相关派生指标，报告里说明 | 强行算 PR 必然错 |

**每一步剔除/填补都必须在 `README.md` 里写明**："剔除 ××（理由），影响：样本量由 N 降为 M"。

### 3.3 单位与口径转换

- 功率 `kW` → 电量 `kWh`：乘以时间间隔（**15 分钟点乘 0.25 h**）。
- `MW ↔ kW`、`MWh ↔ kWh`：×1000。**转换写进变量名**，如 `gen_kwh`，别让下游记错。
- 时间戳：统一到同一时区后转成同一类型（`datetime64` 或字符串），**比较前先确认**。

---

## 4. 脚本规范

### 4.1 组织

- 一个分析一个脚本，文件名带日期与主题：`analyze_2026-09-pr-drop.py`。
- 脚本头部注释写清：**数据来源、统计口径、运行方式**。
- 路径用相对 `scripts/` 目录的路径，或从 `README.md` 里读 —— **不要硬编码 `/home/xxx/...`**。
- **中间量不取整**，只在写结果时舍入。
- 输出同时打印到 stdout（老板当场要看）和 `out/` 文件（后续复核用）。

### 4.2 最小骨架（无 pandas 版）

```python
#!/usr/bin/env python3
"""PR 下降归因分析。

数据来源：analysis/2026-09-30-pr-drop/raw/gen_2026-09.csv
口径：系统效率 PR = 实际发电量 / (装机容量 × 倾斜面辐照量)，辐照源为电站测点
运行：python3 scripts/analyze_2026-09-pr-drop.py（工作目录 = 本分析目录）
"""
import csv, os
from collections import defaultdict
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(BASE, "raw", "gen_2026-09.csv")
OUT = os.path.join(BASE, "out")
os.makedirs(OUT, exist_ok=True)

def load(path):
    """读 CSV → {日期: {逆变器: 发电量kWh}}，同时统计缺失与异常。"""
    daily = defaultdict(lambda: defaultdict(float))
    bad, missing = [], 0
    with open(path, newline="", encoding="utf-8-sig") as f:   # utf-8-sig 兼容 Excel 导出的 BOM
        for i, row in enumerate(csv.DictReader(f), start=2):   # start=2 让人看的行号与文件一致
            try:
                d = datetime.strptime(row["date"], "%Y-%m-%d").date()
                v = float(row["gen_kwh"])
                if v < 0:
                    bad.append((i, "负值", v)); continue
                daily[d][row["inv_id"]] += v
            except (KeyError, ValueError) as e:
                missing += 1
    return daily, bad, missing
```

> **注意上面三个细节**，都是实战踩过的：
> - `encoding="utf-8-sig"`：Excel 导出的 CSV 常带 BOM，用 `utf-8` 读会把第一列名读成 `﻿date`。
> - `start=2`：CSV 报错行号从 2 开始（第 1 行是表头），写进报告才指得清是哪行。
> - 异常值**收集起来报告给用户**，不静默 `continue`。

### 4.3 有 pandas 时的写法

装了 pandas 就用它，但**先 `df.info()` / `df.describe()` 看数据，再写统计**，别拿到表就 `.groupby().sum()`。

---

## 5. 输出与呈现

### 5.1 产出物

| 产出 | 格式 | 注意 |
|---|---|---|
| 明细数据 | CSV | UTF-8 BOM（Excel 直接打开不乱码） |
| 汇总报表 | XLSX（xlsxwriter） | 多 sheet；关键 sheet 加表头格式与数字格式 |
| 图表 | PNG（matplotlib） | **中文字体**：`plt.rcParams['font.sans-serif'] = ['WenQuanYi Zen Hei', 'Noto Sans CJK SC', 'SimHei']`；字体缺失会显示方块 |
| 结论 | Markdown（`README.md`） | 结论先行 + 数据来源 + 遗留问题 |

**图表纪律**：标题写清**时间范围 + 指标 + 口径**；单位标在坐标轴；一条图只讲一件事；不要用 3D/双 Y 轴制造视觉冲击。

### 5.2 结论呈现

```
结论：<一句话判断>
数据：<关键数字，带对比基准>
来源：<文件 / 表 / 时间范围 / 口径版本>
仍不确定：<有什么还没排除，需要什么才能确认>
```

**"仍不确定"不许省。**

---

## 6. 提交前自查清单

- [ ] 原始数据未被修改（`raw/` 只读）
- [ ] 脚本可重跑，跑出同样结果
- [ ] 每个结论数字都能指到来源与口径
- [ ] 缺失/剔除/填补全部有记录与影响说明
- [ ] 中位数与均值都看了（异常值常拉偏均值）
- [ ] 单位转换逐处核对
- [ ] 与 `newenergy-ops-kpi` 的口径一致
- [ ] 图表中文正常显示（不是方块）
- [ ] `README.md` 写清了遗留问题
- [ ] 没装的库 / 用的替代方案已向老板说明
