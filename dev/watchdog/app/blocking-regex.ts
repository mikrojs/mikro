import {version} from 'mikro/sys'

// Sets off the blocking watchdog from inside the regex engine. The pattern
// backtracks exponentially on a string it can never match; the engine
// polls the same interrupt handler as the bytecode loop, so the result is
// the same:
//   [watchdog] WATCHDOG TRIGGERED: event loop blocking time exceeded configured limit of 5000 ms
//   InternalError: interrupted
//       at <anonymous> (app/blocking-regex.ts:...)
//   [panic] restarting in 1000 ms
console.log(`watchdog fixture v${version}: catastrophic regex`)

const input = 'a'.repeat(40) + '!'
console.log('matched: %s', /^(a+)+$/.test(input))
