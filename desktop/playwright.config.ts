import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: 'electron.spec.ts', workers: 1,
  timeout: 60_000, reporter: 'list', outputDir: 'test-results' });
