{
  "name": "{{PLUGIN_ID}}",
  "version": "{{VERSION}}",
  "description": "AGINT 合成产物（TOOL_SYNTHESIS，骨架 + stubs）。意图：{{INTENT_JSON}}。命名契约：Service 形态（schemas + version + 提供单一 agint.* 入口）；存储域 {{DOMAIN}}；零 agint.* host service 依赖。",
  "main": "lib/index.js",
  "agint": {
    "kind": "host",
    "owner": "agint-synth",
    "tier": 2,
    "stability": "experimental"
  },
  "spec": {
    "cordis": {
      "inject": ["storageDomain"],
      "optionalInject": [],
      "provides": ["{{SERVICE_KEY}}"],
      "events": [],
      "tools": []
    },
    "storage": {
      "domains": ["{{DOMAIN}}"],
      "schemaVersion": 1,
      "atomic": "json"
    },
    "dependencies": {
      "zod": "^3.0.0",
      "@deepseek-ai/dsh-storage-domain": ">=0.1.0"
    },
    "mountOrder": 99,
    "permissions": {
      "env": [],
      "fs": [],
      "network": [],
      "shell": false
    },
    "lifecycle": {
      "intervals": "none",
      "listeners": "none",
      "tools": "none",
      "dispose": "domain-only"
    }
  },
  "synth": {
    "generator": "agint-mutator/templates/plugin-synth",
    "skeletonVersion": "1",
    "toolName": "{{TOOL_NAME}}",
    "signature": "{{SIGNATURE_JSON}}",
    "codegen": "skeleton + stubs"
  }
}
