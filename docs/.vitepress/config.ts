import {transformerTwoslash} from '@shikijs/vitepress-twoslash'
import {defineConfig} from 'vitepress'
import {groupIconMdPlugin, groupIconVitePlugin} from 'vitepress-plugin-group-icons'

import {abbrPlugin} from './markdown-abbr.js'

export default defineConfig({
  title: 'Mikro.js',
  tagline: 'Mikro.js - Modern JavaScript, type safety and instant refresh on real hardware',
  appearance: 'dark',

  vite: {
    plugins: [
      //@ts-expect-error
      groupIconVitePlugin(),
    ],
    esbuild: {
      target: 'es2023',
    },
  },
  markdown: {
    theme: {
      light: 'min-light',
      dark: 'material-theme',
    },
    config: (md) => {
      md.use(abbrPlugin)
      md.use(groupIconMdPlugin)
    },
    codeTransformers: [
      transformerTwoslash({
        twoslashOptions: {
          compilerOptions: {
            // Resolve mikro package exports via the "development" condition
            // so Twoslash finds the .ts source files instead of missing .js dist files
            customConditions: ['development'],
          },
        },
      }),
    ],
  },

  head: [
    ['link', {rel: 'icon', href: '/logo.svg'}],
    ['meta', {property: 'og:type', content: 'website'}],
    ['meta', {property: 'og:title', content: 'Mikro.js'}],
    [
      'meta',
      {
        property: 'og:description',
        content: 'Mikro.js - Modern JavaScript, type safety and instant refresh on real hardware',
      },
    ],
    ['meta', {property: 'og:url', content: 'https://mikrojs.dev'}],
    ['meta', {property: 'og:image', content: 'https://mikrojs.dev/og-image.png'}],
  ],

  themeConfig: {
    logo: {src: '/logo.svg', alt: 'Mikro.js logo'},

    nav: [
      {text: 'Getting Started', link: '/getting-started'},
      {text: 'API', link: '/api/'},
      {text: 'Examples', link: '/examples/'},
      {text: 'Contributing', link: '/contributing'},
    ],

    sidebar: [
      {
        text: 'Guide',
        items: [
          {text: 'Getting Started', link: '/getting-started'},
          {text: 'Compatible Boards', link: '/compatible-boards'},
          {text: 'Developing for Microcontrollers', link: '/developing-for-microcontrollers'},
          {text: 'Error Handling', link: '/error-handling'},
          {text: 'Environment Variables', link: '/environment-variables'},
          {text: 'Using npm Packages', link: '/npm-packages'},
          {text: 'Testing', link: '/testing'},
          {text: 'Troubleshooting', link: '/troubleshooting'},
          {text: 'Comparison', link: '/comparison'},
        ],
      },
      {
        text: 'Reference',
        items: [
          {text: 'CLI', link: '/cli'},
          {text: 'Configuration', link: '/config'},
          {text: 'ESLint Rules', link: '/eslint-rules'},
        ],
      },
      {
        text: 'Examples',
        collapsed: true,
        items: [
          {text: 'Overview', link: '/examples/'},
          {text: 'Blinky', link: '/examples/blinky'},
          {text: 'PWM LED', link: '/examples/pwm-led'},
          {text: 'WiFi + Fetch', link: '/examples/wifi-fetch'},
          {text: 'WiFi Access Point', link: '/examples/wifi-access-point'},
          {text: 'UDP Discovery', link: '/examples/udp-discovery'},
          {text: 'NeoPixel', link: '/examples/neopixel'},
          {text: 'SNTP', link: '/examples/sntp'},
          {text: 'UART', link: '/examples/uart'},
          {text: 'BLE Beacon', link: '/examples/ble-beacon'},
          {text: 'BLE GATT', link: '/examples/ble-gatt'},
          {text: 'Schema', link: '/examples/schema'},
        ],
      },
      {
        text: 'API Reference',
        items: [
          {text: 'Overview', link: '/api/'},
          {text: 'Globals and Built-ins', link: '/api/globals'},
          {text: 'env', link: '/api/env'},
          {text: 'result', link: '/api/result'},
          {text: 'observable', link: '/api/observable'},
          {text: 'schema', link: '/api/schema'},
          {text: 'pin', link: '/api/pin'},
          {text: 'pwm', link: '/api/pwm'},
          {text: 'neopixel', link: '/api/neopixel'},
          {text: 'i2c', link: '/api/i2c'},
          {text: 'spi', link: '/api/spi'},
          {text: 'uart', link: '/api/uart'},
          {text: 'wifi', link: '/api/wifi'},
          {text: 'ble', link: '/api/ble'},
          {text: 'http/request', link: '/api/http-request'},
          {text: 'udp', link: '/api/udp'},
          {text: 'sleep', link: '/api/sleep'},
          {text: 'sntp', link: '/api/sntp'},
          {text: 'kv', link: '/api/kv'},
          {text: 'fs', link: '/api/fs'},
          {text: 'cbor', link: '/api/cbor'},
          {text: 'sys', link: '/api/sys'},
          {text: 'test', link: '/api/test'},
        ],
      },
      {
        text: 'Development',
        items: [
          {text: 'Overview', link: '/develop/'},
          {text: 'Custom Firmware', link: '/develop/custom-firmware'},
          {text: 'Building from Source', link: '/develop/building-firmware'},
          {text: 'Creating Drivers', link: '/develop/creating-drivers'},
          {text: 'Creating Boards', link: '/develop/creating-boards'},
          {text: 'Architecture', link: '/develop/architecture'},
          {
            text: 'Internals',
            collapsed: true,
            items: [
              {text: 'Overview', link: '/internals/'},
              {text: 'Runtime Lifecycle', link: '/internals/runtime-lifecycle'},
              {text: 'Event Loop', link: '/internals/event-loop'},
              {text: 'Module System', link: '/internals/module-system'},
              {text: 'Platform Abstraction', link: '/internals/platform-abstraction'},
              {text: 'Node.js Addon', link: '/internals/node-addon'},
            ],
          },
          {text: 'Contributing', link: '/contributing'},
        ],
      },
    ],

    socialLinks: [
      {icon: 'bluesky', link: 'https://bsky.app/profile/mikrojs.dev'},
      {icon: 'github', link: 'https://github.com/mikrojs/mikro'},
      {
        icon: {
          svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-16 -16 185 185"><g transform="translate(16.704 9.9827)"><path class="npmx-sq" d="m0.93476 97.205h24.081v23.693h-24.081z"/><path class="npmx-sl" d="m103.12-9.2307-3.6211 10.246-46.309 131-3.6211 10.246h15.537l3.6211-10.246 11.717-33.148 38.211-108.1z"/></g></svg>',
        },
        link: 'https://npmx.dev/package/mikro',
      },
    ],

    editLink: {
      pattern: 'https://github.com/mikrojs/mikro/edit/main/docs/:path',
    },

    search: {provider: 'local'},
  },
})
