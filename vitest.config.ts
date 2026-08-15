import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
