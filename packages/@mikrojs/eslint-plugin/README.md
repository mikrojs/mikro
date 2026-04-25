# @mikrojs/eslint-plugin

ESLint plugin with rules for Mikro.js projects. Enforces patterns that reduce memory usage and code size on resource-constrained microcontrollers.

## Rules

| Rule                  | Description                                              |
| --------------------- | -------------------------------------------------------- |
| `no-dot-catch`        | Require `.then(onFulfilled, onRejected)` over `.catch()` |
| `no-eval`             | Disallow `eval()`                                        |
| `no-intl`             | Disallow `Intl` APIs (not available in QuickJS)          |
| `no-promise-reject`   | Require Result types instead of rejecting promises       |
| `no-sparse-arrays`    | Disallow sparse arrays                                   |
| `no-throw`            | Require Result types instead of throwing exceptions      |
| `no-try-catch`        | Require Result types instead of try/catch                |
| `no-unhandled-result` | Require checking `.ok` on Result values                  |
| `no-temporal`         | Disallow `Temporal` APIs (not available in QuickJS)      |

## Usage

```js
// eslint.config.js
import mikrojs from '@mikrojs/eslint-plugin'

export default [mikrojs.configs.recommended]
```
