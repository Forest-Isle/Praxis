import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['**/*.test.*', '**/*.spec.*', '**/*.d.ts', '**/__tests__/**'],
      reporter: ['text-summary', 'json-summary'],
      thresholds: {
        statements: 79,
        branches: 70,
        functions: 85,
        lines: 81,
      },
    },
    exclude: [...configDefaults.exclude, '**/.worktrees/**'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
