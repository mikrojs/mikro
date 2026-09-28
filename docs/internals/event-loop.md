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
3. For interval timers, advance `next_deadline` by `timeout` before calling the callback, so the rate stays exact and the phase does not drift as long as the callback fits within the period. If the advanced deadline is still at or before `now` (the loop stalled for a whole period, or the callback runs longer than the interval), `next_deadline` becomes `now + timeout` instead: the timer resumes from now rather than firing back-to-back to catch up
4. For each due timer ID, re-find the timer entry (a previous callback in the same batch may have cleared it), then duplicate the function and arguments and call `JS_Call()`
5. After calling, free the duplicated values
6. For `setTimeout` timers, unschedule after firing

The re-find and duplication steps are important for correctness: a timer callback might call `clearInterval` on itself, clear other timers in the same batch, or schedule new timers. Re-finding by ID handles the case where a timer was cleared by an earlier callback. Duplicating values before calling means the timer entry can be safely modified or removed mid-callback.

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

- **`consume_fn`**: Called every loop iteration. The module checks for pending events (for example a WiFi status change or an HTTP response arrival) and delivers them to JavaScript callbacks.
- **`destroy_fn`**: Called during `MIK_FreeRuntime()` to clean up module state.

### Examples

| Module | What consume does                                        |
| ------ | -------------------------------------------------------- |
| WiFi   | Polls event queue, delivers connect/disconnect callbacks |
| HTTP   | Checks pending requests, resolves fetch promises         |
| stdin  | Reads available bytes, calls input handler               |

Loop consumers are called every iteration regardless of whether they have work to do. The consume function must return quickly when it has no work.

## Waiting between passes

A pass that found nothing to do must not spin. `mik__next_wake_us()` reports how long the loop can sleep: 0 when work is due now (a pending job, a due timer, a stop to report), the microseconds until the earliest timer or watchdog deadline, or -1 when nothing is scheduled. The protocol serve loop does this (simplified: it also falls back to `yield()` on a platform without `wait()`):

```c
while (MIK_Loop(mik_rt) == 0) {
    int64_t wake_us = mik__next_wake_us(mik_rt);
    if (wake_us == 0) {
        MIK_GetPlatform()->yield();  /* busy: let other tasks run */
        continue;
    }
    if (wake_us < 0 || wake_us > 100000) wake_us = 100000; /* the cap */
    MIK_GetPlatform()->wait(wake_us);  /* idle: block until then or a wake */
}
```

`wait()` blocks the task until the timeout elapses or something calls `MIK_Wake()` (`MIK_WakeFromISR()` from an interrupt handler). Every producer that hands the loop work from another task or an ISR calls it after the enqueue: the console RX interrupt, GPIO edges, PWM fades, the WiFi, SNTP and BLE event queues, the HTTP client and server tasks, the UART and I2S drivers. So does code on the JS task that queues work for a consumer, since that consumer may already have run this pass: `ota.check()` and the OTA hooks do. Timers need nothing, since the wait's timeout is the next deadline. The 100 ms cap is a backstop for a producer that forgot. Deadlines that only a loop consumer tracks, such as an HTTP request timeout or the next OTA check-in, can fire up to 100 ms late. UDP sockets have no callback from the socket API, so while one is open the loop polls `recvfrom` every 10 ms.

On ESP-IDF, `wait()` waits on FreeRTOS task notification index 1, which leaves index 0 to native code on the JS task, and `yield()` is `vTaskDelay(1)`. If a wake was already pending at every wait for a second, as under a fast GPIO signal, `wait()` sleeps one tick so the idle task runs. On POSIX, `wait()` is a condition variable and `yield()` is `usleep(1000)`. A platform without `wait()` falls back to `yield()` between passes.

## Promise integration

QuickJS queues promise continuations (`.then`, `.catch`, `await` resumptions) as microtasks. The loop drains all microtasks at the end of each iteration via `JS_ExecutePendingJob()`.

Unhandled promise rejections are tracked via `JS_SetHostPromiseRejectionTracker()`. When a rejection is not handled:

1. A `PromiseRejectionEvent` is dispatched
2. If no handler catches it, the runtime sets `stop_requested`
3. The next loop iteration returns `1`

This way, forgotten `await`s or missing `.catch()` handlers surface as errors rather than disappearing silently.
