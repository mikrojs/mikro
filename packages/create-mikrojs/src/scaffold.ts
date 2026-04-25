import fs from 'node:fs'
import path from 'node:path'

import type {PkgManager} from './pkg-manager.js'
import {dependencies, devDependencies} from './templates/_common/dependencies.js'
import {envExample} from './templates/_common/env-example.js'
import {gitignore} from './templates/_common/gitignore.js'
import {packageJson} from './templates/_common/package-json.js'
import {readme} from './templates/_common/readme.js'
import {tsconfig} from './templates/_common/tsconfig.js'

interface TemplateMeta {
  name: string
  description: string
  hardware?: string
  wiring?: string
  /** true = generate WiFi credentials setup section */
  wifiSetup?: boolean
}

export const TEMPLATES: readonly TemplateMeta[] = [
  {
    name: 'blank',
    description: 'Empty starter project. Prints heap memory usage and exits.',
  },
  {
    name: 'blinky',
    description: 'Blink an LED on and off. The "hello world" of microcontrollers.',
    hardware:
      'Any ESP32 board with a built-in LED, or an external LED connected to a GPIO pin.\n\nChange `PIN` in `app/main.ts` to match your board.',
    wiring: `\`\`\`
  ESP32            LED
  ┌──────┐
  │ GPIO ├───[330Ω]───►|── GND
  │  20  │          (anode) (cathode)
  └──────┘
\`\`\`

Connect the LED's longer leg (anode) to GPIO 20 through a 330-ohm resistor. Connect the shorter leg (cathode) to GND.`,
  },
  {
    name: 'pwm-led',
    description: 'Fade an LED in and out using PWM.',
    hardware: 'LED + resistor on GPIO 21. Change `LED_PIN` in `app/main.ts` for your board.',
    wiring: `\`\`\`
  ESP32            LED
  ┌──────┐
  │ GPIO ├───[330Ω]───►|── GND
  │  21  │          (anode) (cathode)
  └──────┘
\`\`\``,
  },
  {
    name: 'neopixel',
    description:
      'Animated NeoPixel/WS2812B LED patterns: rainbow, comet, breathe, sparkle, color wipe.',
    hardware: [
      'Any ESP32 board + a NeoPixel-compatible LED strip (WS2812 or SK6812).',
      '',
      'Configured for 24 LEDs on GPIO 8 at full brightness.',
      'Edit `PIN`, `NUM_LEDS`, `BRIGHTNESS` in `app/main.ts`.',
    ].join('\n'),
    wiring: `\`\`\`
  ESP32              NeoPixel Strip
  ┌──────┐           ┌──────────┐
  │ GPIO ├───────────┤ DIN      │
  │   8  │           │          │
  │   5V ├───────────┤ 5V       │
  │  GND ├───────────┤ GND      │
  └──────┘           └──────────┘
\`\`\`

For long strips (>8 LEDs), power the strip from an external 5V supply, not the board's USB.`,
  },
  {
    name: 'wifi-fetch',
    description: 'Connect to WiFi and fetch JSON from an HTTP API.',
    hardware: 'Any ESP32 board with WiFi + a WiFi network with internet access.',
    wifiSetup: true,
  },
  {
    name: 'wifi-access-point',
    description: 'Turn the ESP32 into a WiFi access point. Logs station connect/disconnect events.',
    hardware: 'Any ESP32 board with WiFi.',
  },
  {
    name: 'sntp',
    description: 'Sync the device clock via NTP so `new Date()` returns real wall-clock time.',
    hardware: 'Any ESP32 board with WiFi + a WiFi network with internet access.',
    wifiSetup: true,
  },
  {
    name: 'rtc-counter',
    description:
      'Count wake-ups from deep sleep using RTC memory. The counter survives deep sleep but resets on power loss.',
    hardware: 'Any ESP32 board.',
  },
  {
    name: 't-display',
    description:
      'Bouncing DVD logo on a LilyGo T-Display ST7789 LCD. The logo changes color on each bounce; buttons nudge the speed.',
    hardware: [
      '- LilyGo T-Display (ESP32 with built-in 1.14" ST7789 LCD and two buttons)',
      '- Display and pin config from `@mikrojs/lilygo/t-display`',
    ].join('\n'),
  },
] as const

const EXTRA_DEPENDENCIES: Partial<Record<string, Record<string, string>>> = {
  't-display': {'@mikrojs/lilygo': 'latest'},
}

export interface ScaffoldOptions {
  targetDir: string
  template: string
  projectName: string
  mikrojsVersion: string
  typescript?: boolean
  templatesDir: string
  pkgManager: PkgManager
}

export function scaffold(options: ScaffoldOptions) {
  const {
    targetDir,
    template,
    projectName,
    mikrojsVersion,
    typescript = true,
    templatesDir,
    pkgManager,
  } = options

  // Create project directory
  fs.mkdirSync(targetDir, {recursive: true})

  // Copy template files
  const templateDir = path.join(templatesDir, template)
  copyDir(templateDir, targetDir)

  // Write shared files
  fs.writeFileSync(
    path.join(targetDir, 'package.json'),
    JSON.stringify(
      packageJson(projectName, {
        dependencies: {...dependencies, mikrojs: mikrojsVersion, ...EXTRA_DEPENDENCIES[template]},
        devDependencies: typescript ? devDependencies : undefined,
        typescript,
      }),
      null,
      2,
    ) + '\n',
  )
  if (typescript) {
    const hasEnvDts = fs.existsSync(path.join(targetDir, 'env.d.ts'))
    const tsconfigWithIncludes = hasEnvDts
      ? {...tsconfig, include: ['env.d.ts', ...(tsconfig.include ?? [])]}
      : tsconfig
    fs.writeFileSync(
      path.join(targetDir, 'tsconfig.json'),
      JSON.stringify(tsconfigWithIncludes, null, 2) + '\n',
    )
  }
  fs.writeFileSync(path.join(targetDir, '.gitignore'), gitignore)
  fs.writeFileSync(path.join(targetDir, '.env.example'), envExample)

  const templateMeta = TEMPLATES.find((t) => t.name === template)
  const mikro = pkgManager === 'npm' ? 'npx mikro' : 'pnpm mikro'
  const setup = templateMeta?.wifiSetup
    ? `Set your WiFi credentials on the device:\n\n\`\`\`sh\n${mikro} env set WIFI_SSID YourNetworkName\n${mikro} env set WIFI_PASSPHRASE --secret\n\`\`\``
    : undefined
  fs.writeFileSync(
    path.join(targetDir, 'README.md'),
    readme({
      projectName,
      description: templateMeta?.description ?? '',
      pm: pkgManager,
      hardware: templateMeta?.hardware,
      wiring: templateMeta?.wiring,
      setup,
    }),
  )
}

function copyDir(src: string, dest: string) {
  fs.mkdirSync(dest, {recursive: true})
  for (const entry of fs.readdirSync(src, {withFileTypes: true})) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}
