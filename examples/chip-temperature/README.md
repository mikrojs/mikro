# Chip temperature

Firmware with a [native driver](../drivers/chip-temperature), and an app that uses it. `CMakeLists.txt` builds the firmware, and `app/main.ts` is the app. The driver reads the chip's internal temperature sensor, so no wiring is needed. It works on every supported chip except the original ESP32.

## Build and flash the firmware

The firmware includes the driver because `CMakeLists.txt` lists it in `MIKROJS_NATIVE_MODULES`. Building needs ESP-IDF 6.1; see [Custom Firmware](https://mikrojs.dev/develop/custom-firmware).

In a shell where ESP-IDF is active:

```sh
idf.py set-target esp32c6
idf.py build flash
```

## Run the app

```sh
pn mikro dev
```

On firmware without the driver, `mikro dev` stops before it uploads the app and names the missing module.
