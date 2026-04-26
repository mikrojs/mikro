---
title: PWM LED
description: Fade an LED in and out using PWM
---

# PWM LED

A "breathing" LED effect: smoothly fades an LED in and out using PWM. See the [pwm API reference](/api/pwm) for the full type surface.

## Hardware

- Any ESP32 board with a GPIO pin that supports PWM
- An LED connected through a 220-ohm resistor
- USB-C cable

## Code

```ts
import {Pwm} from 'mikrojs/pwm'

// GPIO 15 is the built-in LED on XIAO ESP32C6. Replace with your board's LED pin.
const LED_PIN = 15

const led = new Pwm(LED_PIN, {freq: 50, duty: 0})

// Breathe: smoothly fade in and out forever
while (true) {
  const fadeIn = await led.fade(1.0, 1000)
  if (!fadeIn.ok) {
    console.error('Fade in failed: %s', fadeIn.error.name)
    break
  }

  const fadeOut = await led.fade(0.0, 1000)
  if (!fadeOut.ok) {
    console.error('Fade out failed: %s', fadeOut.error.name)
    break
  }
}
```

## Walkthrough

1. **PWM setup.** `new Pwm(pin, {freq, duty})` creates a PWM channel on the given pin. `freq` sets the PWM frequency in Hz; `duty` sets the initial duty cycle (0.0 to 1.0).

2. **Hardware fading.** `led.fade(target, durationMs)` smoothly transitions the duty cycle to `target` over `durationMs` milliseconds. This runs in hardware on the ESP32's LEDC peripheral, so it does not block the event loop.

3. **Error handling.** Both `fade()` calls return a `Promise<Result>` ([see Result](/api/result)). If something goes wrong (e.g., invalid pin), the loop breaks with a clear error message.

## Create project

::: code-group

```sh [pnpm]
pnpm create mikrojs my-pwm-led --template pwm-led
```

```sh [npm]
npm create mikrojs -- my-pwm-led --template pwm-led
```

```sh [yarn]
yarn create mikrojs my-pwm-led --template pwm-led
```

```sh [bun]
bun create mikrojs my-pwm-led --template pwm-led
```

:::

## Run it

```sh
cd my-pwm-led
```

::: code-group

```sh [pnpm]
pnpm install
pnpm mikro dev
```

```sh [npm]
npm install
npx mikro dev
```

```sh [yarn]
yarn install
yarn mikro dev
```

```sh [bun]
bun install
bunx mikro dev
```

:::

You should see the LED smoothly fading in and out in a continuous breathing pattern.

[View source on GitHub](https://github.com/mikrojs/mikrojs/tree/main/examples/pwm-led)
