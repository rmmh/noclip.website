import { defineConfig } from '@rsbuild/core';
import baseConfig from '../rsbuild.config.js';

export default defineConfig({
  ...baseConfig,
  source: {
    ...baseConfig.source,
    entry: {
      game_regression: './scripts/game_regression_browser.ts',
    },
  },
});
