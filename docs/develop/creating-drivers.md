---
title: Creating Drivers
description: Write a driver for a sensor, display or other peripheral in JavaScript
---

# Creating Drivers

A driver is code for a peripheral, such as a sensor, a display or a motor controller, and apps import it like any other module. This page is about drivers written in JavaScript on the core APIs (`mikro/spi`, `mikro/i2c`, `mikro/gpio`), which work well for most sensors and SPI displays.

::: tip Need C or C++?
When the core APIs are not sufficient, for example for QSPI, DMA transfers, precise timing or a vendor C library, write the driver as a [native module](./native-modules). Refer to [`examples/drivers/chip-temperature`](https://github.com/mikrojs/mikro/tree/main/examples/drivers/chip-temperature) for a complete example.
:::

## The driver package

A JavaScript driver needs nothing from the firmware: it is bundled with the app and runs on any firmware. It is a regular npm package, written in TypeScript and published as JavaScript with type declarations. Refer to [`examples/drivers/bme280`](https://github.com/mikrojs/mikro/tree/main/examples/drivers/bme280) for a complete example.

A driver for the TMP102, an I2C temperature sensor, shows the pattern:

```ts
import {I2c, type I2cError} from 'mikro/i2c'
import {ok, type Result} from 'mikro/result'

const ADDRESS = 0x48

export interface Tmp102 {
  /** The temperature in degrees Celsius. */
  read(): Result<number, I2cError>
  end(): void
}

// Not exported: apps create a Tmp102 with the factory below. The factory's
// return type makes sure that the class matches the Tmp102 interface.
class Tmp102Sensor {
  #i2c: I2c

  constructor(i2c: I2c) {
    this.#i2c = i2c
  }

  read(): Result<number, I2cError> {
    // Register 0x00 holds the temperature: 12 bits, in steps of 1/16 °C.
    const written = this.#i2c.write(ADDRESS, Uint8Array.of(0x00), false)
    if (!written.ok) return written
    const read = this.#i2c.read(ADDRESS, 2)
    if (!read.ok) return read
    const raw = (read.value[0]! << 4) | (read.value[1]! >> 4)
    return ok((raw & 0x800 ? raw - 0x1000 : raw) / 16)
  }

  end(): void {
    this.#i2c.end()
  }
}

export function Tmp102(options: {bus: number; sda: number; scl: number}): Result<Tmp102, I2cError> {
  const i2c = I2c(options.bus, {sda: options.sda, scl: options.scl})
  if (!i2c.ok) return i2c
  return ok(new Tmp102Sensor(i2c.value))
}
```

Follow the conventions of the core modules: a factory named after the handle type, a `Result` for anything that can fail, errors from the core APIs passed on unchanged (see [Error handling](/error-handling)), and an `end()` that is safe to call twice. Use a class even though it isn't exported: its methods are shared between instances, which uses less memory than an object literal with its own functions.

Apps use the driver like a core module:

```ts
import {Tmp102} from '@my-scope/tmp102'

const sensor = Tmp102({bus: 0, sda: 6, scl: 7}).orPanic()
console.log(sensor.read().orPanic())
```

## Sharing pins

Only code that configures a pin claims it. A driver that only reads or writes a pin takes a handle instead, for example `Encoder({a: DigitalIn(4), b: DigitalIn(5)})`, and doesn't call `end()` on it.

Don't give a handle to code that configures the pin again: the owner of the handle keeps using the pin, so two objects drive it, and JavaScript can't detect that. To share a pin, share its handle. Native code claims the pins it configures in C; see [Claiming GPIO pins](./native-modules#claiming-gpio-pins).

## Notes

- Declare `mikro` as a peer dependency, with the versions the driver is tested against, for example `"mikro": "^0.21.0"`.
