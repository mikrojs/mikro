---
title: Event Loop
description: How MIK_Loop drives timers, I/O, and async operations
---

# Event Loop

Mikro.js uses a cooperative, single-threaded event loop. There is no blocking wait or OS-level event notification. The caller drives the loop by calling `MIK_Loop()` repeatedly, and each call processes one batch of pending work.

## Loop iteration

Each call to `MIK_Loop()` performs these steps in order:

```
 ┌─────────────────────────────┐
 │  1. Check stop / exception  │
 ├─────────────────────────────┤
 │  2. Consume stdin           │
 ├─────────────────────────────┤
 │  3. Fire due timers         │
 ├─────────────────────────────┤
 │  4. Poll loop consumers     │
 ├─────────────────────────────┤
 │  5. Drain microtask queue   │
 └─────────────────────────────┘
```

1. **Check stop / exception**: If `stop_requested` is set or an unhandled JS exception exists, dump the error and return `1`.

2. **Consume stdin**: Read any available bytes from stdin and deliver them to the registered handler (if any). This is how the REPL receives input.

3. **Fire due timers**: Check all timers against the current time. For each timer past its deadline, call the callback. `setTimeout` timers are removed after firing; `setInterval` timers have their deadline advanced. See [Timer system](#timer-system) below.

4. **Poll loop consumers**: Call each registered consumer's `consume_fn`. This is how async C modules (WiFi, HTTP) deliver events to JavaScript. See [Loop consumers](#loop-consumers) below.

5. **Drain microtask queue**: Execute all pending promise continuations via `JS_ExecutePendingJob()`. This runs until the microtask queue is empty.

The loop returns `0` to indicate "call me again" or `1` to indicate "stop."

## Timer system

Timers are the primary scheduling mechanism. They implement `setTimeout`, `setInterval`, `clearTimeout`, and `clearInterval`.

### Timer storage

Each timer is stored as a `MIKTimerEntry`:

```c
struct MIKTimerEntry {
    uint32_t id;              // Unique ID (starts at 1)
    bool is_interval;         // false = setTimeout, true = setInterval
    int64_t timeout;          // Delay in microseconds
    int64_t next_deadline;    // Next fire time (boot-relative, microseconds)
    JSValue func;             // Callback function (ref-counted)
    int argc;                 // Number of stored arguments (max 4)
    JSValue argv[4];          // Arguments to pass to callback
};
```

Timer IDs start at 1 (not 0) to avoid issues with falsy checks in JavaScript. The deadline is computed using `platform->get_boot_us()`, which provides microsecond-resolution monotonic time.

### Timer consumption

When `mik__timers_consume()` runs:

1. Get current time from `platform->get_boot_us()`
2. Collect IDs of all due timers into a stack buffer (up to 16 per iteration)
3. For interval timers, reset `next_deadline` to `now + timeout` before calling the callback (prevents re-firing if the callback takes longer than the interval; note this means intervals can drift relative to the original schedule)
4. For each due timer ID, re-find the timer entry (a previous callback in the same batch may have cleared it), then duplicate the function and arguments and call `JS_Call()`
5. After calling, free the duplicated values
6. For `setTimeout` timers, unschedule after firing

The re-find and duplication steps are important for correctness: a timer callback might call `clearInterval` on itself, clear other timers in the same batch, or schedule new timers. Re-finding by ID handles the case where a timer was cleared by an earlier callback. Duplicating values before calling ensures the timer entry can be safely modified or removed mid-callback.

### Maximum arguments

Timer callbacks support up to 4 extra arguments, matching the browser API:

```js
setTimeout(callback, 100, arg1, arg2, arg3, arg4)
```

## Loop consumers

Loop consumers are how C modules with ongoing async work integrate with the event loop. A module registers a consumer during its initialization:

```c
typedef void (*MIKLoopConsumeFn)(JSContext* ctx);
typedef void (*MIKLoopDestroyFn)(JSContext* ctx);

MIK_RegisterLoopConsumer(mik_rt, consume_fn, destroy_fn);
```

- **`consume_fn`**: Called every loop iteration. The module checks for pending events (e.g., WiFi status change, HTTP response arrival) and delivers them to JavaScript callbacks.
- **`destroy_fn`**: Called during `MIK_FreeRuntime()` to clean up module state.

### Examples

| Module | What consume does                                        |
| ------ | -------------------------------------------------------- |
| WiFi   | Polls event queue, delivers connect/disconnect callbacks |
| HTTP   | Checks pending requests, resolves fetch promises         |
| stdin  | Reads available bytes, calls input handler               |

Loop consumers are called every iteration regardless of whether they have work to do. The consume function should return quickly when idle.

## Yield

Between loop iterations, the caller should yield to prevent busy-waiting:

```c
while (MIK_Loop(mik_rt) == 0) {
    MIK_GetPlatform()->yield();
}
```

On POSIX, `yield()` is `usleep(1000)` (1ms sleep). On ESP-IDF, it yields the FreeRTOS task, allowing other tasks (WiFi stack, etc.) to run.

## Promise integration

QuickJS queues promise continuations (`.then`, `.catch`, `await` resumptions) as microtasks. The loop drains all microtasks at the end of each iteration via `JS_ExecutePendingJob()`.

Unhandled promise rejections are tracked via `JS_SetHostPromiseRejectionTracker()`. When a rejection is not handled:

1. A `PromiseRejectionEvent` is dispatched
2. If no handler catches it, the runtime sets `stop_requested`
3. The next loop iteration returns `1`

This ensures that forgotten `await`s or missing `.catch()` handlers surface as errors rather than silently disappearing.
