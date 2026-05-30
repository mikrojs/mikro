---
layout: home

hero:
  name: Mikro.js
  text: TypeScript for microcontrollers
  tagline: Modern JavaScript, type safety and fast refresh on real hardware.

  image:
    src: /logo.svg
    alt: Mikro.js logo
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/mikrojs/mikro

features:
  - title: Fast feedback loop
    details: Interactive dev console with watch mode and incremental builds that deploy to your device in a few seconds.
  - title: Full TypeScript
    details: Near-complete ES2024 support, type-checked hardware APIs, and editor autocomplete.
  - title: Batteries included<span class="tip" data-tip="the metaphorical kind, not the kind you use to power your ESP32">*</span>
    details: <a href="/api/pin">GPIO</a>, <a href="/api/pwm">PWM</a>, <a href="/api/i2c">I2C</a>, <a href="/api/spi">SPI</a>, <a href="/api/uart">UART</a>, <a href="/api/wifi">WiFi</a>, <a href="/api/http-request">HTTP</a>, <a href="/api/udp">UDP</a>, <a href="/api/neopixel">NeoPixel</a>, <a href="/api/sleep">deep sleep</a>, <a href="/api/sntp">SNTP</a>, <a href="/api/cbor">CBOR</a>, <a href="/api/schema">schema validation</a>, <a href="/api/kv">key-value storage</a>, and more.
  - title: Host simulator
    details: Run your code on your computer with <code>mikro sim dev</code>. No microcontroller needed.
  - title: No exceptions
    details: Typed Result errors instead of try/catch. Every failure is visible in the type signature.
  - title: Built-in testing
    details: Test suites with resource leak detection and more. Run in the simulator or on a real device.
---

## Your first program

Blinky: the "Hello, World!" of tiny devices.

<CodeWiringTabs>
<template #code>

```ts twoslash
import {digitalWrite, pinMode} from 'mikro/pin'
import {sleep} from 'mikro/sleep'

// Replace with your board's LED GPIO pin if different
const LED_PIN = 15

pinMode(LED_PIN, 'OUTPUT').orPanic('Failed to set pin mode')

while (true) {
  digitalWrite(LED_PIN, 1)
  await sleep(500)
  digitalWrite(LED_PIN, 0)
  await sleep(500)
}
```

</template>
<template #wiring>
<BlinkyDiagram />
</template>
</CodeWiringTabs>

Get it running:

::: code-group

```sh [npm]
npm create mikro -- --template blinky
cd my-blinky
npm install
npx mikro dev
```

```sh [pnpm]
pnpm create mikro --template blinky
cd my-blinky
pnpm install
pnpm mikro dev
```

```sh [yarn]
yarn create mikro --template blinky
cd my-blinky
yarn install
yarn mikro dev
```

```sh [bun]
bun create mikro --template blinky
cd my-blinky
bun install
bunx mikro dev
```

:::

## Learn more

- [Getting Started](/getting-started): set up your first project step by step
- [Error Handling](/error-handling): learn how Mikro.js uses typed Results instead of exceptions
- [API Reference](/api/): explore GPIO, WiFi, I2C, SPI, and more
- [Examples](/examples/): blinky, PWM, WiFi, NeoPixel, UART, and more
