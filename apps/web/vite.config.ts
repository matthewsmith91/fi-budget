import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 'prompt' so a new bundle (and its migrations) never swaps in mid-edit
      registerType: 'prompt',
      includeAssets: ['favicon.ico', 'favicon.svg', 'apple-touch-icon-180x180.png'],
      manifest: {
        name: 'Household Budget',
        short_name: 'Budget',
        description: 'Shared envelope budgeting for the household',
        theme_color: '#1f7a5a',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm}'],
        navigateFallback: 'index.html',
        // Server-owned paths must reach the server, not be answered with the app shell
        navigateFallbackDenylist: [/^\/api\//, /^\/health/],
      },
      devOptions: { enabled: false },
    }),
  ],
  // sqlite-wasm locates its .wasm via import.meta.url, which pre-bundling breaks
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm'] },
  worker: { format: 'es' },
  // In production the server serves the app and the API from one origin; mirror that in dev.
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
      '/health': 'http://localhost:3001',
    },
  },
})
