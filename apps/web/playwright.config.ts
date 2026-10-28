import { defineConfig } from '@playwright/test'

// Runs against the production build: the service worker only exists there.
// Uses the system Chrome so no browser download is needed (CI runners ship it).
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:4173', channel: 'chrome' },
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
