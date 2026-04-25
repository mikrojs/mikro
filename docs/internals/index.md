---
title: Internals Overview
description: How the Mikro.js runtime works under the hood
---

# Internals

This section documents how the Mikro.js runtime works internally. It is aimed at contributors who want to understand, modify, or extend the core engine.

For build system details, module registration macros, and the bytecode pipeline from a driver developer's perspective, see [Architecture](/develop/architecture).

## Key concepts

**[Runtime lifecycle](/internals/runtime-lifecycle)** covers how `MIKRuntime` is created, configured, driven, and destroyed. The runtime wraps a QuickJS engine instance and owns all associated state: timers, modules, environment, and per-module data slots.

**[Event loop](/internals/event-loop)** explains what happens each time `MIK_Loop()` is called. The loop processes stdin, fires due timers, polls loop consumers (WiFi, HTTP, etc.), and drains the microtask queue. There is no blocking wait; the caller drives the loop.

**[Module system](/internals/module-system)** describes how `import` statements resolve at runtime. Four sources are checked in order: virtual modules, native C modules, bytecode builtins, and the filesystem. Each has different registration and loading mechanics.

**[Platform abstraction](/internals/platform-abstraction)** documents the `MIKPlatform` interface that decouples the runtime from any specific OS or hardware. Implementations exist for POSIX (desktop) and ESP-IDF (ESP32). Adding a new port means implementing this interface.

**[Node.js addon](/internals/node-addon)** covers how the runtime runs on a desktop via a Node-API addon: async loop integration, the host bridge for bidirectional messaging, the preprocessor hook for TypeScript, and RPC calls.

## Source layout

The core runtime lives in `packages/@mikrojs/native/`:

```
packages/@mikrojs/native/
├── include/mikrojs/
│   ├── mikrojs.h        Public C API
│   ├── private.h        Internal structs (MIKRuntime, MIKTimerEntry)
│   ├── platform.h       MIKPlatform interface
│   └── errors.h         Error code definitions
├── src/
│   ├── mikrojs.cpp      Runtime lifecycle + event loop
│   ├── modules.cpp      Module loader and normalizer
│   ├── builtins.cpp     Bytecode builtin registry
│   ├── timers.cpp       Timer scheduling and consumption
│   ├── platform_posix.cpp  POSIX platform implementation
│   └── mik_*.cpp        Built-in C modules (sys, fs, stdio, cbor)
├── runtime/             TypeScript modules compiled to bytecode
└── addon/               Node-API addon for desktop
```

ESP-specific modules live in `packages/@mikrojs/firmware/components/mikrojs/`:

```
components/mikrojs/
├── platform_esp32.cpp   ESP-IDF platform implementation
├── mik_pin.cpp          GPIO module
├── mik_wifi.cpp         WiFi module
├── mik_http.cpp         HTTP client module
├── mik_serial_io.cpp    Serial I/O module
└── ...
```
