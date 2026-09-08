# dedicated/ — 专用 runner 管辖的场景

本目录下的场景文件**不归主 driver 加载**（driver 只扫 `scenarios/` 顶层）。
各自由专属评估器读取：

- `agint-mutator.scenario.json` → `eval/run-mutator-eval.mjs`
- `agint-diagnosis-counterfactual.scenario.json` → `eval/run-counterfactual-stress.mjs`

新增专属场景文件也放这里，并在本 README 登记对应 runner。
