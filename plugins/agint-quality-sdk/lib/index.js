/**
 * agint-quality-sdk: Prompt SDK 插件 (Sprint 5)
 *
 * Provides:
 *   - agint.promptSDK service: 暴露 staticCheck / validate / render / runTests
 *   - CLI: bin/agint-prompt-init.js (Sprint 5.2)
 *   - examples/ (Sprint 5.3)
 *
 * FROZEN:
 *   - PromptManifestSchema (lib/schema.js)
 * ADJUSTABLE:
 *   - maxTokens / modelHint / tags
 *
 * Row (profile cordis.patch.yml):
 *   - insert:
 *       - id: agint-quality-sdk
 *         name: ./plugins/agint-quality-sdk/lib/index.js
 *         config: {}
 */

import { z } from '../../agint-quality/node_modules/zod/index.js';
import { validateManifest, PromptManifestSchema } from './schema.js';
import { renderPrompt, extractPlaceholders, checkPlaceholdersAgainstManifest } from './template-engine.js';
import { staticCheckPrompt, runRegressionTests } from './static-check.js';

const name = 'agint-quality-sdk';
const inject = [];

const Config = z.object({
  /** strict 模式 = blocker 直接 fail；advisory = warn-only */
  defaultStaticCheckMode: z.enum(['strict', 'advisory']).default('strict'),
}).optional();

function apply(ctx, config) {
  const cfg = Config.parse(config || {});
  let disposed = false;

  ctx.effect(() => () => {
    disposed = true;
  });

  /**
   * Service: agint.promptSDK
   */
  const promptSDK = {
    /** FROZEN: validate manifest */
    validate(manifest) {
      if (disposed) throw new Error('agint-quality-sdk: disposed');
      return validateManifest(manifest);
    },

    /** Render a prompt with values */
    render({ templateText, manifest, values } = {}) {
      if (disposed) throw new Error('agint-quality-sdk: disposed');
      return renderPrompt({ templateText, manifest, values });
    },

    /** Static check: three risk classes */
    staticCheck({ templateText, manifest } = {}) {
      if (disposed) throw new Error('agint-quality-sdk: disposed');
      return staticCheckPrompt({ templateText, manifest });
    },

    /** Run manifest.regressionTests */
    runTests({ templateText, manifest }) {
      if (disposed) throw new Error('agint-quality-sdk: disposed');
      return runRegressionTests({
        templateText,
        manifest,
        render: ({ templateText, manifest, values }) => renderPrompt({ templateText, manifest, values }),
      });
    },

    /** Schema exports for external use */
    schema: PromptManifestSchema,

    health() {
      return { serviceAvailable: true, version: '0.5.0' };
    },

    config: cfg,
  };

  ctx.provide('agint.promptSDK', promptSDK);
}

export {
  Config, apply, inject, name,
  validateManifest, renderPrompt, extractPlaceholders, staticCheckPrompt, runRegressionTests,
};
