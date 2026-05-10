# Contributing to mikrojs

Thanks for your interest in contributing to mikrojs! All contributions are welcome, whether it's a bug fix, a new feature, improved docs, or just a question.

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold it.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- [pnpm](https://pnpm.io/) 10.30.1+
- [EIM](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/index.html) (Espressif IDE Manager) with ESP-IDF >= 6.0.1 (for firmware builds)

## Getting started

```sh
git clone --recurse-submodules https://github.com/mikrojs/mikrojs
cd mikrojs
pnpm install
```

If you already cloned without `--recurse-submodules`:

```sh
git submodule update --init --recursive
```

For firmware builds, install ESP-IDF >= 6.0.1 via [EIM](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/get-started/index.html) before proceeding:

```sh
eim install -i v6.0.1 -t all -n true
```

## Node.js / TypeScript

```sh
pnpm typecheck                  # Type-check all packages (tsc --noEmit)
pnpm lint                       # Run oxlint (type-aware)
pnpm fmt                        # Format with oxfmt
pnpm fmt:check                  # Check formatting
pnpm precommit                  # Runs lint + fmt:check
pnpm knip                       # Check for unused code/exports
pnpm --filter mikrojs build     # Build the mikrojs CLI package
pnpm vitest                     # Run JS/TS tests
```

## Standalone C++ library (host)

The core runtime can be built and tested on the host without any ESP-IDF dependencies:

```sh
pnpm run build:lib              # CMake build of libmikrojs.a (includes bytecode generation)
pnpm run test:lib               # Run host-side C++ tests (ctest)
pnpm run clean:lib              # Remove CMake build directory
```

Or directly:

```sh
cd packages/@mikrojs/native
cmake -B build && cmake --build build
ctest --test-dir build --output-on-failure
```

## ESP-IDF firmware

### One-time setup

Make sure ESP-IDF >= 6.0.1 is installed (see [Prerequisites](#prerequisites)), then:

```sh
cd esp32
direnv allow
idf.py set-target esp32c6  # or esp32, esp32s3, etc.
```

The `idf.py` command in `esp32/` is a wrapper that runs through `eim run`, so no manual ESP-IDF activation is needed.

### Build and flash

```sh
cd esp32
idf.py build flash monitor
```

> **Note:** `sdkconfig.defaults` is only applied when `sdkconfig` does not exist. To apply changes from `sdkconfig.defaults`, delete `sdkconfig` and re-run `idf.py set-target <target>` (the target must be re-set since it's stored in `sdkconfig`).

## Testing

### Unit tests (no device needed)

```sh
pnpm vitest                     # Run all JS/TS unit tests
pnpm test:lib                   # Run host-side C++ tests (builds automatically)
```

### On-device protocol tests

Integration tests that exercise the unified TLV serial protocol against a real device. These are vitest tests gated behind an environment variable so they're skipped in normal runs.

**Prerequisites:** a device flashed with the current firmware, connected via USB serial.

```sh
# Auto-detect serial port
pnpm --filter mikrojs test:device

# Or specify the port explicitly
DEVICE_PORT=/dev/tty.usbmodem1101 pnpm --filter mikrojs test:device
```

The tests deploy a minimal test app, then exercise eval, console output (log/warn/error), directives, tab completion, deploy (single file, large file, incremental, env vars), config CRUD, unicode handling, and restart/reconnect.

### ESP32 C++ tests (Unity)

Lower-level C++ tests that run directly on the ESP32. These test the runtime, modules, timers, filesystem, and GPIO using the Unity framework via serial monitor.

```sh
cd esp32
pnpm test
```

If tests error, try `cd test && idf.py fullclean` first.

Test files live in `packages/@mikrojs/firmware/components/mikrojs/test/` with categories: `[runtime]`, `[modules]`, `[timers]`, `[fs]`, `[gpio]`.

## IDE setup

### CLion

Using direnv and opening the project from the terminal (`clion .`) should work out of the box.

## Code style

### C/C++

Formatting enforced by `.clang-format` (Google base style, 4-space indent, 100-char line limit). Static analysis via `.clang-tidy`.

### TypeScript

Linting via `oxlint` (type-aware), formatting via `oxfmt`. Run `pnpm lint` and `pnpm fmt:check` to verify.
