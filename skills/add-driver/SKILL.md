---
name: add-driver
description: Scaffold a mikrojs driver package for a hardware peripheral. Use this skill whenever the user wants to create a driver for a sensor, display, motor controller, LED strip, or any other hardware peripheral, wants to create a driver package, or asks how to wrap a C/C++ hardware library for JavaScript. Even if the user just says "I want to add support for [hardware X]", this skill applies.
---

# Create a mikrojs Driver Package

A driver is an npm package that apps import like a core module. Decide the kind first:

- **JavaScript driver** (the default): TypeScript on the core APIs (`mikro/i2c`, `mikro/spi`, `mikro/gpio`, `mikro/uart`). It deploys with the app and runs on any firmware. Reference: `docs/develop/creating-drivers.md` and `examples/drivers/bme280`.
- **Native driver**: a native module, C or C++ compiled into custom firmware. Use it only when the core APIs are not enough: QSPI or DMA transfers, precise timing, or a vendor C library. Reference: `docs/develop/native-modules.md` and `examples/drivers/chip-temperature`.

Read the reference page and example for the kind you pick before writing files; they are the source of truth, and this skill only summarizes them.

## What you need from the user

1. **npm scope and package name** (e.g. `@my-scope/bme280`). Never `@mikrojs`, which is reserved for first-party packages.
2. **Hardware interface** (I2C, SPI, GPIO, UART, ...) and the chip's datasheet or a reference driver.
3. **The JS API** apps should get (e.g. `read()`, `draw(pixels)`).
4. **Whether the core APIs are enough.** If they are, write a JavaScript driver.

## JavaScript driver

Copy the layout of `examples/drivers/bme280`: `package.json`, `tsconfig.json`, TypeScript source, built to `dist/` with `tsc`. `package.json` exports the built files and declares `mikro` as a plain peer dependency with the versions the driver is tested against (no `peerDependenciesMeta`).

Follow the conventions of the core modules:

- A PascalCase factory named after the handle type returns a `Result`: `Tmp102(options): Result<Tmp102, I2cError>`. Declare `interface Tmp102` and `function Tmp102` together (declaration merging), and implement the handle as a class that is not exported, so its methods are shared between instances.
- Anything that can fail returns a `Result`. Pass errors from the core APIs on unchanged (`if (!r.ok) return r`), or add context with `err(new Error('...', {cause: r.error}))`.
- `end()` releases the bus or pins, and is safe to call twice.
- The core APIs claim the pins they configure. A driver that only reads or writes a pin takes a handle, such as `DigitalIn(4)`, and does not call `end()` on it.
- Device code: function declarations over `const` arrows, no small callback helpers (each closure costs RAM in QuickJS), and `sleep(ms)` from `mikro/sleep` for delays.

## Native driver

```
{scope}/{name}/
  package.json
  {module}/
    CMakeLists.txt        # the ESP-IDF component
    {module}.cpp          # registers "{scope}/{name}/{module}"
    {module}.d.ts         # the types apps compile against
```

`package.json` makes the module a package export whose `native` condition points at the source:

```json
{
  "name": "{scope}/{name}",
  "version": "0.1.0",
  "type": "module",
  "files": ["{module}"],
  "exports": {
    "./{module}": {"types": "./{module}/{module}.d.ts", "native": "./{module}/{module}.cpp"}
  },
  "peerDependencies": {"@mikrojs/firmware": "^0.21.0", "mikro": "^0.21.0"}
}
```

`{module}/CMakeLists.txt`:

```cmake
idf_component_register(
    SRCS "{module}.cpp"
    INCLUDE_DIRS "."
    REQUIRES mikrojs
)
# The module registers itself from a static library; without this the linker
# drops it. The argument is the first argument of MIK_REGISTER_PUBLIC_MODULE.
mikrojs_force_include_modules({id})
target_compile_definitions(${COMPONENT_LIB} PRIVATE "MIK_PACKAGE_NAME=\"{scope}/{name}\"")
```

In the C++ (see the full example in `docs/develop/native-modules.md`):

- Register with `MIK_REGISTER_PUBLIC_MODULE({id}, "{scope}/{name}/{module}", init, consume, destroy)` and create the module with `JS_NewCModule` under the same name. The compiler checks that the name starts with `MIK_PACKAGE_NAME`.
- Each export needs `JS_AddModuleExport` in the init function and `JS_SetModuleExport` when the module is evaluated.
- Apps import the module directly, so validate every argument in C: types, ranges, buffer lengths.
- Return `Result`s with `MIK_ResultOk`, `MIK_ResultOkVoid` and `MIK_ResultErrNamed`.
- Claim the pins it configures with `MIK_ClaimGpios(ctx, gpios, count, "ClassName")`, and release them with `MIK_ReleaseGpios` in `end()` and the finalizer. For a native handle, call `MIK_KeepHandle(ctx, obj)` when creating it and `MIK_DropHandle(ctx, this_val)` in `end()`.
- Get class IDs with `MIK_NewClassID(rt, &id)`, never `JS_NewClassID`.
- Give the component folder a unique name after what it contains (`sh8601`), not `main`, `mikrojs`, `native`, `src` or the name of an ESP-IDF component.
- Compile vendor C libraries as `.c` files, and allocate DMA buffers with `heap_caps_malloc(size, MALLOC_CAP_DMA)`.

## Testing

- **JavaScript driver:** build it (`pn build`), import it from an app, and deploy with `pn mikro dev`.
- **Native driver:** build custom firmware that lists the module. An app can be its own firmware project, as in `examples/chip-temperature`: a `CMakeLists.txt` next to its `package.json` with `set(MIKROJS_NATIVE_MODULES "{scope}/{name}/{module}")`. Build and flash it with `idf.py set-target <chip>` and `idf.py build flash`, then deploy the app with `pn mikro dev`.
