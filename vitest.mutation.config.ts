import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.js'

// For mutation testing (stryker.config.json). cli.test.ts runs the built
// dist/index.js in a child process, which no mutant of src/ reaches.
export default mergeConfig(
  base,
  defineConfig({
    test: { exclude: [...configDefaults.exclude, 'tests/cli.test.ts'] },
  }),
)
