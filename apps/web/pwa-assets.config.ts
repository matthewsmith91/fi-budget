import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

// Regenerate icons from public/icon.svg with: npx pwa-assets-generator
export default defineConfig({
  preset: minimal2023Preset,
  images: ['public/icon.svg'],
})
