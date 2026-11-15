import { defineConfig, presetAttributify, presetIcons, presetUno } from 'unocss'

export default defineConfig({
  content: {
    pipeline: {
      include: [
        /\.(vue|svelte|[jt]sx|mdx?|astro|elm|php|phtml|html)($|\?)/,
        'src/**/*.{js,ts}',
      ],
    },
  },
  shortcuts: {
    'i-carbon-list-blocked': 'i-fas-ban',
    'i-carbon-user-offline': 'i-fas-user-slash',
    'i-carbon-leaf': 'i-fas-leaf',
    'i-carbon-crown': 'i-fas-crown',
    'i-carbon-circle': 'i-fas-circle',
    'i-fas-circle-notch-function': 'i-fas-circle-notch',
    'i-fas-circle-notch-string': 'i-fas-circle-notch',
    'i-fas-circle-notch-return': 'i-fas-circle-notch',
  },
  presets: [
    presetUno(),
    presetAttributify(),
    presetIcons({
      scale: 1.2,
      warn: true,
      safelist: [
        'i-fas-ban',
        'i-fas-user-slash',
        'i-fas-leaf',
        'i-fas-crown',
        'i-fas-circle',
        'i-fas-circle-notch',
      ],
      collections: {
        carbon: () => import('@iconify-json/carbon/icons.json').then(i => i.default),
        fas: () => import('@iconify-json/fa-solid/icons.json').then(i => i.default),
        'svg-spinners': () => import('@iconify-json/svg-spinners/icons.json').then(i => i.default),
      },
    }),
    // 不使用 presetWebFonts：构建时会网络拉取 Google Fonts（DM Sans 等），
    // Azure 服务器偶发超时导致构建失败。字体回退到系统字体栈。
  ],
})
