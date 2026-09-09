# fixture-B-implemented（有实现）

> **故意有实现 fixture**：本目录的 README.md 含加权合成公式，且 lib/index.js 真有实现——用于验证 plugin-check dim 10 检测是否能正确识别"有实现"。

## 公式

score = 0.5 * metric_a + 0.5 * metric_b

## 实现位置

`lib/index.js` 的 `computeComposite()` 函数。