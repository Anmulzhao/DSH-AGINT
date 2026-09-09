# fixture-A-detached（脱节）

> **故意脱节 fixture**：本目录的 README.md + CHANGELOG.md 含加权合成公式，但 plugins/ 全仓无对应实现代码——用于验证 plugin-check dim 10 检测是否能报警。

## HARM 公式

本插件定义质量指标 HARM_score = 0.4·Q + 0.6·E（其中 Q = quality、E = efficiency）。

## 默认权重

harmWeights: { Q: 0.4, E: 0.6 }，待 policy 模块接入。

## 设计意图

本公式来自设计稿 §X.X，作为参考文档保留以描述未来 HARM 实现规划。

<!-- ALLOW-FORMULA-DOC：此公式故意保留在文档以描述未来意图 -->

## 版本

- v0.1.0 — 2026-09-09