{
  "name": "{{PLUGIN_ID}}",
  "version": "{{VERSION}}",
  "private": true,
  "description": "AGINT TOOL_SYNTHESIS 合成产物（模板生成，禁止手改逻辑体）",
  "main": "lib/index.js",
  "type": "module",
  "exports": {
    ".": "./lib/index.js"
  },
  "agint": {
    "synth": true,
    "templateVersion": "1"
  }
}
