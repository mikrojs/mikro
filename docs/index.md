---
layout: home

hero:
  name: Mikro.js
  text: TypeScript for microcontrollers
  tagline: Modern JavaScript, type safety and instant refresh on real hardware.

  image:
    src: /logo.svg
    alt: Mikro.js logo
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/mikrojs/mikrojs

features:
  - title: Instant feedback
    details: Save a file, see it running on your device in seconds. Live reload over serial.
  - title: Full TypeScript
    details: Type-checked hardware APIs with modern ES support. Errors are in the type signature, not hidden behind try/catch.
  - title: Batteries included<span class="tip" data-tip="the metaphorical kind, not the kind you use to power your ESP32">*</span>
    details: GPIO, PWM, I2C, SPI, UART, WiFi, <a href="/api/http-request">HTTP</a>, NeoPixel, <a href="/api/sleep">deep sleep</a>, <a href="/api/sntp">SNTP</a>, <a href="/api/cbor">CBOR</a>, <a href="/api/schema">schema validation</a>, <a href="/api/kv">key-value storage</a>, and more.
  - title: Host simulator
    details: Run and test your code on your computer with mikro sim dev. No microcontroller needed.
  - title: No exceptions
    details: Typed Result errors instead of try/catch. Every failure is visible in the type signature.
  - title: Built-in testing
    details: Write tests with familiar describe/it syntax. Run on-device, in the simulator, or against stubbed hardware modules.
---

## Your first program

Blinky: the "Hello, World!" of tiny devices.

<CodeWiringTabs>
<template #code>

```ts twoslash
import {digitalWrite, pinMode} from 'mikrojs/pin'
import {sleep} from 'mikrojs/sleep'

// Replace with your board's LED pin if different
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
npm create mikrojs -- my-blinky --template blinky
cd my-blinky
npm install
npx mikro dev
```

```sh [pnpm]
pnpm create mikrojs my-blinky --template blinky
cd my-blinky
pnpm install
pnpm mikro dev
```

```sh [yarn]
yarn create mikrojs my-blinky --template blinky
cd my-blinky
yarn install
yarn mikro dev
```

```sh [bun]
bun create mikrojs my-blinky --template blinky
cd my-blinky
bun install
bunx mikro dev
```

:::

## Learn more

- [Getting Started](/getting-started) — set up your first project step by step
- [Error Handling](/error-handling) — learn how Mikro.js uses typed Results instead of exceptions
- [API Reference](/api/) — explore GPIO, WiFi, I2C, SPI, and more
- [Examples](/examples/) — blinky, PWM, WiFi, NeoPixel, UART, and more
