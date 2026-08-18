# agint-quality-contract

D-QAF 评估框架核心契约。**仅定义接口与 Schema,不写实现**。

## 角色

- 提供 `agint.quality` Host Service
- 暴露 FROZEN 接口定义 + ADJUSTABLE 配置 schema
- 实现由 sibling 插件提供:
  - `agint-quality-eval` (QualityEvaluator 实现)
  - `agint-quality-policy` (QualityPolicy 实现)
  - `agint-quality-sandbox` (执行基础设施)
  - `agint-quality-report` (QualityReporter 实现)

## 二元边界 (提案 3d6cc063)

| 层 | 内容 | 修改门槛 |
|:--|:--|:--|
| **FROZEN** | 接口签名、Safety 红线、决策枚举、维度定义 | 人类多签 + CI 检查禁止 |
| **ADJUSTABLE** | HARM 权重、评分阈值、沙箱限制、梦境预算 | policy 自调 + 审计日志 |

## 验证 (与 K18/K19 一致)

仅做 mount-validate **不足以** 证明可用性。需跑 `scripts/verify-quality-contract.mjs`(待补):
1. 启动 DSH web
2. 真实调用 `agint.quality.getConfig()` / `setConfig()` / `isFrozen()` / `schemas`
3. 验证 Schema 校验生效(reject 无效 payload)
4. 验证 FROZEN 标记正确

## 行挂载 (profile cordis.patch.yml)

```yaml
- insert:
    - id: agint-quality-contract
      name: ./plugins/agint-quality/agint-quality-contract/lib/index.js
      config: {}
```

## 来源

- (projects/AGINT/DSH-AGINT-D-QAF融合方案.md §2.1, L46-92)
- (projects/AGINT/DSH自进化系统评估框架完整汇总.md §5.2-5.4, L130-155)
- (proposal id 3d6cc063 — "画清 D-QAF 评估评估者 的二元边界")
