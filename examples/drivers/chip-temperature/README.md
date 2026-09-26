# Chip temperature

An example of a native driver: the chip's internal temperature sensor, written in C++ and compiled into the firmware. It needs no wiring, and works on every supported chip except the original ESP32. See [Native Modules](https://mikrojs.dev/develop/native-modules).

```ts
import {ChipTemperature} from '@mikrojs-examples/chip-temperature'

const sensor = ChipTemperature().orPanic()
console.log('%d °C', sensor.read().orPanic())
```

The app in [`examples/chip-temperature`](../../chip-temperature) builds firmware with this module and reads the sensor.
