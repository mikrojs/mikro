import {noDotCatch} from './rules/no-dot-catch.js'
import {noEval} from './rules/no-eval.js'
import {noIntl} from './rules/no-intl.js'
import {noPromiseReject} from './rules/no-promise-reject.js'
import {noSparseArrays} from './rules/no-sparse-arrays.js'
import {noTemporal} from './rules/no-temporal.js'
import {noThrow} from './rules/no-throw.js'
import {noTryCatch} from './rules/no-try-catch.js'
import {noUnhandledResult} from './rules/no-unhandled-result.js'

const plugin = {
  meta: {
    name: '@mikrojs/eslint-plugin',
    version: '0.0.0',
  },
  rules: {
    'no-unhandled-result': noUnhandledResult,
    'no-throw': noThrow,
    'no-try-catch': noTryCatch,
    'no-promise-reject': noPromiseReject,
    'no-dot-catch': noDotCatch,
    'no-eval': noEval,
    'no-intl': noIntl,
    'no-temporal': noTemporal,
    'no-sparse-arrays': noSparseArrays,
  },
  configs: {} as Record<string, unknown[]>,
}

// Self-referencing: configs reference the plugin object.
// Type-aware rules require a parser (typescript-eslint) configured by the
// consumer; this config only registers @mikrojs/* rules.
Object.assign(plugin.configs, {
  recommended: [
    {
      files: ['**/*.ts', '**/*.tsx'],
      plugins: {
        '@mikrojs': plugin,
      },
      rules: {
        '@mikrojs/no-unhandled-result': 'error',
        '@mikrojs/no-throw': 'error',
        '@mikrojs/no-try-catch': 'error',
        '@mikrojs/no-promise-reject': 'error',
        '@mikrojs/no-dot-catch': 'error',
        '@mikrojs/no-eval': 'error',
        '@mikrojs/no-intl': 'error',
        '@mikrojs/no-temporal': 'error',
        '@mikrojs/no-sparse-arrays': 'warn',
      },
    },
  ],
})

export default plugin
