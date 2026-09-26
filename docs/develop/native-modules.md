---
title: Native Modules
description: Write a module in C or C++, compile it into the firmware, and import it like any other module
---

# Native Modules

A native module is a module written in C or C++. It is compiled into the firmware, and apps import it by its package name:

```ts
import {Epaper} from '@my-scope/epaper/panel'
```

::: info Native modules must be built with custom firmware
An app can't import C or C++ source the way it imports JavaScript. The module has to be compiled into the firmware, which means a [custom firmware](./custom-firmware) build.
:::

Use a native module when JavaScript isn't enough: for QSPI or DMA transfers, for precise timing, or to call a vendor C library. A native module doesn't have to be a driver; a codec, for example, is packaged the same way. A driver that doesn't need C or C++ should be written in JavaScript instead; see [Creating Drivers](./creating-drivers).

Examples:

- [`examples/drivers/chip-temperature`](https://github.com/mikrojs/mikro/tree/main/examples/drivers/chip-temperature): a native driver for the chip's internal temperature sensor
- [`examples/chip-temperature`](https://github.com/mikrojs/mikro/tree/main/examples/chip-temperature): firmware built with that driver, and an app that uses it

## Declare the module in package.json

A native module is a package export whose `native` condition points to the C++ source. A `types` condition next to it gives TypeScript the declarations:

```json
{
  "name": "@my-scope/epaper",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    "./panel": {
      "types": "./panel.d.ts",
      "native": "./panel.cpp"
    }
  },
  "peerDependencies": {
    "@mikrojs/firmware": "^0.1.0",
    "mikro": "^0.1.0"
  }
}
```

The package needs nothing more. TypeScript checks imports against `panel.d.ts`. A firmware build compiles the folder that holds `panel.cpp` when the firmware project lists the module. `mikro deploy` uploads no code for a native module; it only makes sure that the device's firmware includes it.

The export can be the package root (`"."`, imported as `@my-scope/epaper`) or a subpath. The package can export JavaScript modules too, such as a wrapper with an easier API. These import the native module and are deployed with the app like any other JavaScript.

## The source folder

ESP-IDF compiles components, which are folders with a `CMakeLists.txt`. So the folder that contains the source file needs one:

```
@my-scope/epaper/
├── package.json
├── CMakeLists.txt
├── panel.cpp          registers "@my-scope/epaper/panel"
└── panel.d.ts
```

The folder can be anywhere in the package, and several modules can share it. A package with several native modules, like `@acme/drivers`, usually has one folder for each.

::: warning Give each folder a unique name
ESP-IDF names a component after its folder. If two components have the same name, it uses one and ignores the other without an error. So the firmware build stops when a native module's folder has the same name as:

- the folder of another native module
- `main` or `mikrojs`, which every firmware has
- an ESP-IDF component, for example `json` or `console`
- a component in the firmware project's `components/` or `managed_components/` folder

Name the folder after what it contains (`sh8601`, `bme280`), not `native` or `src`.
:::

## The C++ module

```cpp
#include <mikrojs/mikrojs.h>

/* Epaper(options) -> Result<Epaper, EpaperError> */
static JSValue js_epaper_open(JSContext* ctx, JSValueConst this_val, int argc,
                              JSValueConst* argv) {
    if (argc < 1 || !JS_IsObject(argv[0])) {
        return MIK_ResultErrNamed(ctx, "EpaperError", "options must be an object");
    }
    // Read and check every option, claim pins, set up the bus, return a Result.
    return MIK_ResultErrNamed(ctx, "EpaperError", "not implemented");
}

// Called when the module is evaluated: set the export values.
static int mik__epaper_module_init(JSContext* ctx, JSModuleDef* m) {
    return JS_SetModuleExport(ctx, m, "Epaper",
                              JS_NewCFunction(ctx, js_epaper_open, "Epaper", 1));
}

// Called on first import: declare the exports.
static JSModuleDef* mik__epaper_init(JSContext* ctx) {
    JSModuleDef* m = JS_NewCModule(ctx, "@my-scope/epaper/panel", mik__epaper_module_init);
    if (!m) return nullptr;
    JS_AddModuleExport(ctx, m, "Epaper");
    return m;
}

MIK_REGISTER_PUBLIC_MODULE(epaper, "@my-scope/epaper/panel", mik__epaper_init, nullptr, nullptr)
```

::: warning Validate every argument
Apps can import the native module directly, so check the input in C, even if a JavaScript wrapper checks it too. Check types and ranges, and check the length of a buffer before you read it.
:::

- `MIK_REGISTER_PUBLIC_MODULE` registers the module when the firmware starts, so `main.cpp` doesn't change. The module initializes on its first import.
- The second argument is the name that apps import. The compiler makes sure that it starts with the `MIK_PACKAGE_NAME` that the component's `CMakeLists.txt` sets.
- The last two arguments are optional hooks. The runtime calls the first on every iteration of the event loop once the module is imported. Use it to hand results from interrupts or background tasks to JavaScript. The runtime calls the second when it shuts down. Pass `nullptr` for a hook you don't need.
- Each export needs two calls: `JS_AddModuleExport` in the init function, and `JS_SetModuleExport` when the module is evaluated. Without the second, the export is `undefined`.
- Follow the conventions of the public API: a PascalCase factory that returns a `Result`, handle methods that return `Result`s, and an `end()` that is safe to call twice. `mikrojs/mikrojs.h` has `MIK_ResultOk(ctx, value)`, `MIK_ResultOkVoid(ctx)` and `MIK_ResultErrNamed(ctx, "EpaperError", "reset failed: %s", reason)` for this.

Apps can't import `native:` names; those belong to the runtime.

## CMakeLists.txt

```cmake
idf_component_register(
    SRCS "panel.cpp"
    INCLUDE_DIRS "."
    REQUIRES mikrojs esp_driver_spi esp_driver_gpio
)
# The module registers itself from a static library. Without this, the linker
# drops the object file. The argument is the first argument of
# MIK_REGISTER_PUBLIC_MODULE.
mikrojs_force_include_modules(epaper)
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_PACKAGE_NAME=\"@my-scope/epaper\"")
```

Put this file in the source folder, and add any other sources, such as a vendor C library, to `SRCS`.

Keep `mikrojs` in `REQUIRES`. The `mikrojs` component defines `mikrojs_force_include_modules`, and ESP-IDF processes a component's requirements before the component itself.

Add an `idf_component.yml` only if the component needs packages from the IDF Component Registry. An empty `dependencies:` key makes the build fail with "Input should be a valid dictionary".

## panel.d.ts

```ts
import type {GpioInUse} from 'mikro/gpio'
import type {Result} from 'mikro/result'

export interface EpaperOptions {
  spiHost: number
  clk: number
  mosi: number
  cs: number
  reset: number
  busy: number
}

export type EpaperError = GpioInUse | {name: 'EpaperError'; message: string}

export interface Epaper {
  draw(pixels: Uint8Array): Result<void, EpaperError>
  end(): void
}

/** Claims the SPI bus and pins and initializes the panel. */
export declare function Epaper(options: EpaperOptions): Result<Epaper, EpaperError>
```

Nothing checks that this file agrees with the C++, so keep the two side by side and change them together.

## Adding the module to firmware

Adding the package to the app's dependencies doesn't change the firmware. A firmware build includes a native module when the [custom firmware](./custom-firmware) project lists it in `MIKROJS_NATIVE_MODULES`. Separate several names with `;`.

```cmake
set(MIKROJS_NATIVE_MODULES "@my-scope/epaper/panel")
```

Before `mikro deploy` uploads an app, it makes sure that the device's firmware includes every native module the app imports, and stops if one is missing:

```
This app imports a native module that the device's firmware (esp32c6-generic)
was not built with:
  @my-scope/epaper/panel
List it in your firmware project's MIKROJS_NATIVE_MODULES, build the firmware,
and flash that build:
  mikro flash --build-dir <your-firmware-build>
To create a firmware project, see https://mikrojs.dev/develop/custom-firmware
```

### Optional native modules

If the app can work without the module, load it with a dynamic `import()`. `mikro deploy` checks only static imports, so a missing module that the app loads with `import()` doesn't stop the upload. On firmware without the module, the import fails when it runs, and the app carries on without it:

```ts
let epaper
try {
  epaper = await import('@my-scope/epaper/panel')
} catch (error) {
  console.error('Cannot load the e-paper module:', error)
}
```

The error is `TypeError: Failed to resolve module specifier '@my-scope/epaper/panel'`.

## Native modules inside an app

An app that builds its own firmware can keep native modules of its own, without a separate package. The app is then also the [custom firmware](./custom-firmware) project: its `package.json` depends on `@mikrojs/firmware`, and the firmware's `CMakeLists.txt` is next to it. Map a `#` import to the source in the `imports` field of the app's `package.json`. Unlike an export, a `#` import is private to the app:

```json
{
  "name": "my-app",
  "type": "module",
  "imports": {
    "#sensor": {
      "types": "./native/sensor/sensor.d.ts",
      "native": "./native/sensor/sensor.cpp"
    }
  },
  "dependencies": {
    "@mikrojs/firmware": "^0.1.0"
  }
}
```

```
my-app/
├── package.json
├── CMakeLists.txt         set(MIKROJS_NATIVE_MODULES "#sensor")
├── app/main.ts            import {Sensor} from '#sensor'
└── native/sensor/
    ├── CMakeLists.txt
    ├── sensor.cpp         registers "#sensor"
    └── sensor.d.ts
```

The firmware build looks up a `#` entry in the nearest `package.json` at or above the firmware project that has an `imports` entry for it. The firmware project can also be in a folder of the app, such as `firmware/`, if that folder has no `package.json` of its own; with one, npm would not find `@mikrojs/firmware` in the app's dependencies. For several modules, one pattern entry covers a folder of them. With `"#native/*": {"types": "./native/*/*.d.ts", "native": "./native/*/*.cpp"}`, `#native/sensor` is `./native/sensor/sensor.cpp`.

The C++ and its `CMakeLists.txt` differ from a package's in two places:

- Name the module `#sensor` in `MIK_REGISTER_PUBLIC_MODULE` and `JS_NewCModule`.
- Leave `MIK_PACKAGE_NAME` out. Without it, the compiler accepts only names that start with `#`.

```cmake
idf_component_register(
    SRCS "sensor.cpp"
    INCLUDE_DIRS "."
    REQUIRES mikrojs
)
mikrojs_force_include_modules(sensor)
```

Only the app can do this. A `#` name is private to one package, but the firmware has one module for each name, so `mikro deploy` stops when a package's own `imports` point at C or C++. A package exports its native modules instead.

## Claiming GPIO pins

Each GPIO pin has one owner at a time. `mikro/gpio`, `Pwm`, the bus modules and the console record their pins in a shared claim table, and native code that configures a pin must claim it there too. Otherwise two modules can drive the same pin, and the app gets no error.

1. Before you configure the pins, claim them with `MIK_ClaimGpios(ctx, gpios, count, "Epaper")`. Pass the class name as a string literal; apps see it in `GpioInUse` errors. If a pin is already in use, the call releases the pins it claimed and returns a `GpioInUse` error Result for you to return to the app. Otherwise it returns `JS_UNDEFINED`.
2. In `end()` and in the finalizer, release the pins with `MIK_ReleaseGpios(gpios, count, "Epaper")`. A release frees only claims with the same name, so it can't free a pin that another module has claimed since.
3. If the handle is a native class, call `MIK_KeepHandle(ctx, obj)` when you create it and `MIK_DropHandle(ctx, this_val)` in `end()`. The handle then stays alive until `end()`, even when the app no longer refers to it.

```cpp
const int gpios[] = {options.reset, options.busy};
JSValue in_use = MIK_ClaimGpios(ctx, gpios, 2, "Epaper");
if (!JS_IsUndefined(in_use)) return in_use;
```

`MIK_ClaimGpio`, `MIK_ReleaseGpio` and `MIK_GpioOwner` do the same for a single pin.

Code that only reads or writes a pin doesn't claim it; it takes a handle to it instead. See [Sharing pins](./creating-drivers#sharing-pins).

## Testing a native module

1. Create a [custom firmware](./custom-firmware) project that depends on the package, and name the module in `MIKROJS_NATIVE_MODULES`.
2. Build and flash it:

   ```sh
   idf.py set-target esp32c6
   idf.py build flash
   ```

3. With `mikro dev`, deploy a small app that imports the module.

Keep this firmware project in the package's repository and build it in CI, so that every push shows whether the module still compiles.

## Notes

- Declare `mikro` and `@mikrojs/firmware` as peer dependencies, with the versions the module is tested against.
- A module that stores data in NVS needs a namespace of its own. Names that start with `mik.` belong to the runtime.
- Compile vendor C libraries as `.c` files. In `.cpp` files they can fail under `-Werror`.
- Allocate DMA buffers with `heap_caps_malloc(size, MALLOC_CAP_DMA)`. DMA needs internal SRAM, so buffers in PSRAM don't work.
