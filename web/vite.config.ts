import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { visualizer } from 'rollup-plugin-visualizer'
import UnoCSS from 'unocss/vite'
import { defineConfig } from 'vite'
import viteCompression from 'vite-plugin-compression'

const corePackageJson = JSON.parse(readFileSync('../core/package.json', 'utf-8'))
const buildRequire = createRequire(import.meta.url)
const { buildMutationCatalog } = buildRequire('../core/src/services/mutation-catalog-data.js')

function bundledMutationCatalog() {
  const filenames = [
    'MutantEffect.json',
    'ItemInfo.json',
    'collections/CollectionSeries.json',
    'collections/CollectionGroup.json',
    'collections/CollectionItem.json',
    'collections/MutantPublicity.json',
  ]
  const source = JSON.parse(readFileSync(new URL('../core/src/gameConfig/collections/sources.json', import.meta.url), 'utf8'))
  const inputs: Record<string, any[]> = {}
  const files: Record<string, { sha256: string, origin: string }> = {}
  for (const filename of filenames) {
    const bytes = readFileSync(new URL(`../core/src/gameConfig/${filename}`, import.meta.url))
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const key = filename.split('/').at(-1)!.replace('.json', '')
    if (filename.startsWith('collections/') && source.files[key]?.sha256 !== sha256)
      throw new Error(`Bundled mutation source hash mismatch: ${filename}`)
    inputs[key] = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(inputs[key]))
      throw new Error(`Bundled mutation source is not an array: ${filename}`)
    files[filename] = { sha256, origin: filename.startsWith('collections/') ? `${source.repository}@${source.commit}` : 'local-game-config' }
  }
  const items = new Map(inputs.ItemInfo!.map(item => [Number(item.id), item]))
  const catalog = buildMutationCatalog(inputs.MutantEffect, { ...inputs, source }, (id: number) => items.get(Number(id)))
  // Art must exist in the frontend's own static root, not just in the backend.
  const bundledArt = (image: string) => image.startsWith('/game-config/') && existsSync(new URL(`./public${image}`, import.meta.url)) ? image : ''
  for (const effect of [...catalog.normal, ...catalog.decoration]) effect.image = bundledArt(effect.image)
  for (const series of catalog.collections) {
    for (const item of series.items) {
      // 与物品接口使用同一官方资源名；新补图不是 deco_icons/<物品ID>.png。
      const icon = String(items.get(Number(item.id))?.icon_res || '')
        .replace(/\/(?:spriteFrame|texture)$/, '')
        .split('/')
        .filter(Boolean)
        .at(-1) || ''
      item.image = (icon ? bundledArt(`/game-config/deco_icons/${icon}.png`) : '')
        || bundledArt(`/game-config/deco_icons/${item.id}.png`)
        || bundledArt(`/game-config/seed_images_named/mutant/${icon}.png`)
    }
  }
  const revision = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 12)
  return { ...catalog, bundle: { revision, collectionsCommit: source.commit, files, origin: 'bundled-local-config' } }
}
const mutationBundle = bundledMutationCatalog()

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue(),
    UnoCSS() as any,
    viteCompression({
      verbose: true,
      disable: false,
      threshold: 10240,
      algorithm: 'gzip',
      ext: '.gz',
    }),
    visualizer({
      open: false,
      gzipSize: true,
      brotliSize: true,
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('vue') || id.includes('pinia') || id.includes('vue-router') || id.includes('@vueuse')) {
              return 'vendor-vue'
            }
            if (id.includes('axios')) {
              return 'vendor-axios'
            }
            // Split other large dependencies if needed
            if (id.includes('echarts') || id.includes('zrender')) {
              return 'vendor-echarts'
            }
            // Default vendor chunk
            return 'vendor'
          }
        },
      },
    },
    chunkSizeWarningLimit: 1000,
  },
  define: {
    __APP_VERSION__: JSON.stringify(corePackageJson.version),
    // Only the dedicated loopback build permits anonymous, network-free viewing.
    __LOCAL_UI_READONLY__: process.env.FARM_LOCAL_UI_READONLY === '1',
    // Compiled from real, hash-checked rule files. No Node/session modules are
    // imported by the browser and the bundled rules require no API/fetch.
    __MUTATION_CATALOG__: JSON.stringify(mutationBundle),
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    proxy: {
      '/socket.io': {
        target: 'http://localhost:3007',
        changeOrigin: true,
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3007',
        changeOrigin: true,
      },
      '/game-config': {
        target: 'http://localhost:3007',
        changeOrigin: true,
      },
    },
  },
})
