---
title: Getting Started
description: Set up your first Mikro.js project and blink an LED
---

::: warning Early development
Mikro.js is in its early days and not intended for safety-critical or production applications. APIs may change, and you should expect (and [report](https://github.com/anthropics/mikrojs/issues)!) bugs.
:::

# Getting Started

Mikro.js is for learners, hobbyists, and creators who want to tinker with hardware and build cool stuff.

This guide walks you through creating a Mikro.js project, flashing firmware to a board, and deploying your first TypeScript program.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/installation) recommended, but npm and yarn work too
- A USB-C cable
- An ESP32 development board

::: warning Bun is untested
Bun has not been tested with Mikro.js. Use npm, pnpm, or yarn for now.
:::

::: tip Which board should I use?
Any ESP32, ESP32-C3, ESP32-S3, or ESP32-C6 board should work out of the box. We recommend the [Seeed Studio XIAO ESP32C6](https://www.seeedstudio.com/Seeed-Studio-XIAO-ESP32C6-p-5884.html): it's small, cheap (~$5), has USB-C, and is the primary board Mikro.js is developed and tested against.
:::

## Create a project

::: code-group

```sh [pnpm]
pnpm create mikrojs my-app
cd my-app
pnpm install
```

```sh [npm]
npm create mikrojs -- my-app
cd my-app
npm install
```

```sh [yarn]
yarn create mikrojs my-app
cd my-app
yarn install
```

:::

This scaffolds a project with the following structure:

```
my-app/
├── app/
│   └── main.ts       # Your program entry point
├── package.json
└── tsconfig.json
```

## Plug in your board

Connect your ESP32 board to your computer via USB-C.

## Flash the firmware

::: code-group

```sh [pnpm]
pnpm mikro flash
```

```sh [npm]
npx mikro flash
```

```sh [yarn]
yarn mikro flash
```

:::

This writes the Mikro.js runtime firmware into the board's flash memory, setting up the environment your TypeScript code runs in. You only need to do this once per board (or when updating Mikro.js).

## Develop

Run `mikro dev`:

::: code-group

```sh [pnpm]
pnpm mikro dev
```

```sh [npm]
npx mikro dev
```

```sh [yarn]
yarn mikro dev
```

:::

This connects to your board, deploys your code, and watches for changes. Now open `app/main.ts` in your preferred code editor or IDE and write a blink program:

```ts twoslash
import {digitalWrite, pinMode} from 'mikrojs/pin'
import {sleep} from 'mikrojs/sleep'

// GPIO 15 is the built-in LED on XIAO ESP32C6. Replace with your board's LED pin.
const LED = 15

pinMode(LED, 'OUTPUT').orPanic('Failed to set pin mode')

while (true) {
  digitalWrite(LED, 1)
  await sleep(500)
  digitalWrite(LED, 0)
  await sleep(500)
}
```

Every time you save, the new code is deployed to the device within seconds.

## Deploy it

When you're happy with your program, deploy it permanently:

::: code-group

```sh [pnpm]
pnpm mikro deploy
```

```sh [npm]
npx mikro deploy
```

```sh [yarn]
yarn mikro deploy
```

:::

This writes your program to the device's flash storage. It will keep running after reboot, without a computer connected.

## Next steps

- [Error Handling](/error-handling): learn how Mikro.js uses typed Results instead of exceptions
- [WiFi + Fetch example](/examples/wifi-fetch): connect to the internet and make HTTP requests
- [API Reference](/api/): explore the full API surface
