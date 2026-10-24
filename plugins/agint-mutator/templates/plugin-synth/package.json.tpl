{
  "name": "{{PLUGIN_ID}}",
  "version": "{{VERSION}}",
  "private": true,
  "description": "AGINT TOOL_SYNTHESIS 合成产物（模板生成，禁止手改逻辑体）",
  "main": "src/index.js",
  "type": "module",
  "exports": {
    ".": "./src/index.js"
  },
  "agint": {
    "synth": true,
    "templateVersion": "1"
  }
}
