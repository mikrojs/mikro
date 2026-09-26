# BME280

An example of a pure JS driver: the Bosch BME280 temperature, humidity and pressure sensor over I2C. It uses only `mikro/i2c`, so it runs on any Mikro.js firmware. See [Creating Drivers](https://mikrojs.dev/develop/creating-drivers).

```ts
import {Bme280} from '@mikrojs-examples/bme280'

const sensor = Bme280({bus: 0, sda: 6, scl: 7}).orPanic()
const reading = sensor.read().orPanic()
console.log('%d °C, %d %%, %d Pa', reading.temperature, reading.humidity, reading.pressure)
```

Build it with `pn build`, which writes `dist/`.
