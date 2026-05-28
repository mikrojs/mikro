import fs from 'node:fs'
import path from 'node:path'

import {mikroCommand, type PkgManager} from './pkg-manager.js'
import {
  dependencies,
  devDependencies,
  eslintDevDependencies,
} from './templates/_common/dependencies.js'
import {editorconfig} from './templates/_common/editorconfig.js'
import {envExample} from './templates/_common/env-example.js'
import {eslintConfig} from './templates/_common/eslint-config.js'
import {gitignore} from './templates/_common/gitignore.js'
import {mikroConfig} from './templates/_common/mikro-config.js'
import {packageJson} from './templates/_common/package-json.js'
import {prettierConfig} from './templates/_common/prettier-config.js'
import {readme} from './templates/_common/readme.js'
import {tsconfigJson} from './templates/_common/tsconfig.js'

interface TemplateMeta {
  name: string
  description: string
  hardware?: string
  wiring?: string
  /** true = generate WiFi credentials setup section */
  wifiSetup?: boolean
  /** Env vars consumed by this template — listed in .env.example and .env */
  envVars?: readonly string[]
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
    envVars: ['WIFI_SSID', 'WIFI_PASSPHRASE'],
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
    envVars: ['WIFI_SSID', 'WIFI_PASSPHRASE'],
  },
  {
    name: 'rtc-counter',
    description:
      'Count wake-ups from deep sleep using RTC memory. The counter survives deep sleep but resets on power loss.',
    hardware: 'Any ESP32 board.',
  },
  {
    name: 'schema',
    description:
      'Define and validate runtime data shapes with `mikrojs/schema`, including tagged unions.',
    hardware: 'Any ESP32 board.',
  },
  {
    name: 'uart',
    description: 'Send and receive bytes over UART using a loopback wire.',
    hardware:
      'Any ESP32 board with at least two free GPIO pins.\n\nChange `TX_PIN` and `RX_PIN` in `app/main.ts` to match your board.',
    wiring: `\`\`\`
  ESP32C6
  ┌──────┐
  │ GPIO ├──┐
  │  16  │  │  jumper wire
  │ GPIO ├──┘
  │  17  │
  └──────┘
\`\`\`

Connect GPIO 16 (RX) to GPIO 17 (TX) with a jumper wire so the example can read back its own writes.`,
  },
  {
    name: 'udp-discovery',
    description:
      'Devices on the same LAN find each other via UDP multicast announcements every couple of seconds.',
    hardware: 'Any ESP32 board with WiFi + a WiFi network.',
    wifiSetup: true,
    envVars: ['WIFI_SSID', 'WIFI_PASSPHRASE'],
  },
  {
    name: 'ble-beacon',
    description:
      'Broadcast a sensor reading in BLE advertising packets. No connections; just transmit.',
    hardware:
      'Any ESP32 family board with BLE (ESP32-C3, ESP32-C6, ESP32-S3, original ESP32). ESP32-S2 has no BLE radio.',
  },
  {
    name: 'ble-gatt',
    description:
      'Connectable GATT peripheral with live notifications and a writable command characteristic.',
    hardware:
      'Any ESP32 family board with BLE (ESP32-C3, ESP32-C6, ESP32-S3, original ESP32). ESP32-S2 has no BLE radio.',
  },
] as const

export interface ScaffoldOptions {
  targetDir: string
  template: string
  projectName: string
  mikrojsVersion: string
  templatesDir: string
  pkgManager: PkgManager
}

export function scaffold(options: ScaffoldOptions) {
  const {targetDir, template, projectName, mikrojsVersion, templatesDir, pkgManager} = options

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
        dependencies: {...dependencies, mikrojs: `^${mikrojsVersion}`},
        devDependencies: {
          ...devDependencies,
          ...eslintDevDependencies,
          '@mikrojs/eslint-plugin': `^${mikrojsVersion}`,
        },
      }),
      null,
      2,
    ) + '\n',
  )
  const hasEnvDts = fs.existsSync(path.join(targetDir, 'env.d.ts'))
  fs.writeFileSync(
    path.join(targetDir, 'tsconfig.json'),
    tsconfigJson(hasEnvDts ? ['env.d.ts'] : []),
  )
  fs.writeFileSync(path.join(targetDir, 'eslint.config.js'), eslintConfig)
  fs.writeFileSync(path.join(targetDir, '.prettierrc.json'), prettierConfig)
  // Write a default mikro.config.ts unless the template ships its own.
  const mikroConfigPath = path.join(targetDir, 'mikro.config.ts')
  if (!fs.existsSync(mikroConfigPath)) {
    fs.writeFileSync(mikroConfigPath, mikroConfig)
  }
  fs.writeFileSync(path.join(targetDir, '.editorconfig'), editorconfig)
  fs.writeFileSync(path.join(targetDir, '.gitignore'), gitignore)
  const templateMeta = TEMPLATES.find((t) => t.name === template)
  const envFileContent = envExample(templateMeta?.envVars)
  fs.writeFileSync(path.join(targetDir, '.env.example'), envFileContent)
  // Also scaffold a .env (gitignored) so users can fill values in
  // directly without copying from .env.example.
  fs.writeFileSync(path.join(targetDir, '.env'), envFileContent)

  const setup = templateMeta?.wifiSetup
    ? `Set your WiFi credentials on the device:\n\n\`\`\`sh\n${mikroCommand(pkgManager, 'env set WIFI_SSID YourNetworkName --no-secret')}\n${mikroCommand(pkgManager, 'env set WIFI_PASSPHRASE')}\n\`\`\``
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
