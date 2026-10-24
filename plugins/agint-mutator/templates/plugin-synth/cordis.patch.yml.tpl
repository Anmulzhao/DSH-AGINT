# {{PLUGIN_ID}} — AGINT TOOL_SYNTHESIS 合成产物（模板生成）
#
# 本文件由 agint-mutator 的受控插件模板填充产出，供 agint-mount 的
# PREPARE 阶段写入 staging 后加载。模板本身 L0-frozen。
#
# ⛔ 合成产物默认不挂进生产 profile：挂载必须走
#    quality-static(l0-isolation) → quality-sandbox(SMOKE) → mount 三段式，
#    且阶段失败须可回滚。

insert:
  - id: {{PLUGIN_ID}}
    name: ./src/index.js
    config: {}
