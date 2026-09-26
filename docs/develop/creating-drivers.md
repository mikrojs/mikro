---
title: Creating Drivers
description: Build a driver for a sensor, display or other peripheral, in pure JavaScript or with native code
---

# Creating Drivers

A driver is code for a peripheral, such as a sensor, a display or a motor controller, and apps import it like any other module. There are two kinds:

1. **Pure JS drivers** use the core APIs (`mikro/spi`, `mikro/i2c`, `mikro/gpio`). They are bundled with the app and run on any firmware. This works well for most sensors and SPI displays.
2. **Native drivers** are [native modules](./native-modules): C or C++ that is compiled into the firmware. Use one when the core APIs are not sufficient: QSPI, DMA transfers, precise timing, or a vendor C library.

To the app, both kinds look the same: a PascalCase factory that returns a `Result`.

```ts
import {Bme280} from '@my-scope/bme280'

const sensor = Bme280({bus: 0, sda: 6, scl: 7}).orPanic()
```

## Pure JS driver

A pure JS driver needs nothing from the firmware. It is a normal TypeScript package, built to JavaScript with type declarations:

```
@my-scope/bme280/
├── package.json
├── tsconfig.json    builds bme280.ts into dist/
├── bme280.ts
└── dist/            bme280.js and bme280.d.ts
```

```json
{
  "name": "@my-scope/bme280",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["mikro-driver"],
  "exports": {
    ".": "./dist/bme280.js"
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  },
  "peerDependencies": {
    "mikro": "^0.1.0"
  },
  "peerDependenciesMeta": {
    "mikro": {"optional": true}
  }
}
```

```ts
import {I2c, type I2cError} from 'mikro/i2c'
import {ok, type Result} from 'mikro/result'

export interface Bme280Options {
  bus: number
  sda: number
  scl: number
  address?: number
}

export interface Reading {
  temperature: number
  humidity: number
  pressure: number
}

export interface Bme280 {
  read(): Result<Reading, I2cError>
  end(): void
}

// Not exported: apps create a Bme280 with the factory below. The factory's
// return type makes sure that the class matches the Bme280 interface.
class Bme280Sensor {
  #i2c: I2c

  constructor(i2c: I2c) {
    this.#i2c = i2c
  }

  read(): Result<Reading, I2cError> {
    // ... read the registers and convert them
  }

  end(): void {
    this.#i2c.end()
  }
}

export function Bme280(options: Bme280Options): Result<Bme280, I2cError> {
  const i2c = I2c(options.bus, {sda: options.sda, scl: options.scl})
  if (!i2c.ok) return i2c
  // ... probe the chip, read calibration data
  return ok(new Bme280Sensor(i2c.value))
}
```

Follow the conventions of the core modules: the factory has the same name as the handle type, anything that can fail returns a `Result`, and `end()` returns nothing and is safe to call twice. Return errors from the core APIs unchanged (see [Error handling](/error-handling)).

Keep the class private and export only the factory and the interface. A class shares its methods between instances, which uses less memory than an object literal that creates them again for each instance.

[`examples/drivers/bme280`](https://github.com/mikrojs/mikro/tree/main/examples/drivers/bme280) is the complete driver, with the calibration and compensation code left out above.

## Native driver

Write a native driver as a [native module](./native-modules). Follow the conventions above, and claim every pin that the driver configures. See [Claiming GPIO pins](./native-modules#claiming-gpio-pins).

[`examples/drivers/chip-temperature`](https://github.com/mikrojs/mikro/tree/main/examples/drivers/chip-temperature) is a complete native driver for the chip's internal temperature sensor.

## Sharing pins

Only code that configures a pin claims it. A pure JS driver that only reads or writes a pin takes a handle instead, for example `Encoder({a: DigitalIn(4), b: DigitalIn(5)})`, and doesn't call `end()` on it.

Don't give a handle to code that configures the pin again: the owner of the handle keeps using the pin, so two objects drive it, and JavaScript can't detect that. To share a pin, share its handle.

## Notes

- If your driver stores data in NVS, use your own namespace. Names that start with `mik.` belong to the runtime.
- Add the `mikro-driver` keyword so that people can find the package on npm.
- Mark `mikro` as an optional peer dependency, as in the example. The driver needs it only for its types; on the device, the firmware provides `mikro/*`. A required peer also breaks preview installs: a range like `^0.1.0` never matches a prerelease version, so with `autoInstallPeers` a stable copy of `mikro` is installed next to the preview.
