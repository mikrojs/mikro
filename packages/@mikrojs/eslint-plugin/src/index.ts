import tseslint from 'typescript-eslint'

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

// Self-referencing: configs reference the plugin object
Object.assign(plugin.configs, {
  recommended: tseslint.config(
    {
      files: ['**/*.ts', '**/*.tsx'],
      extends: [tseslint.configs.recommended],
      plugins: {
        '@mikrojs': plugin,
      },
      rules: {
        // Unused vars (allow underscore prefix)
        'no-unused-vars': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
        ],
        // Type imports: use inline {type X} for mixed, top-level import type for all-type
        '@typescript-eslint/consistent-type-imports': [
          'error',
          {
            prefer: 'type-imports',
            fixStyle: 'inline-type-imports',
            disallowTypeAnnotations: false,
          },
        ],
        '@typescript-eslint/no-import-type-side-effects': 'error',
        // Relax overly strict rules
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-require-imports': 'off',
        '@typescript-eslint/no-unused-expressions': 'off',
        '@typescript-eslint/no-empty-object-type': 'off',
        '@typescript-eslint/ban-ts-comment': 'off',
      },
    },
    {
      files: ['**/*.ts', '**/*.tsx'],
      languageOptions: {
        parserOptions: {
          projectService: true,
        },
      },
      rules: {
        // Error handling
        '@mikrojs/no-unhandled-result': 'error',
        '@mikrojs/no-throw': 'error',
        '@mikrojs/no-try-catch': 'error',
        '@mikrojs/no-promise-reject': 'error',
        '@mikrojs/no-dot-catch': 'error',
        // Floating promises (type-aware)
        '@typescript-eslint/no-floating-promises': 'error',
        // Performance & correctness
        '@mikrojs/no-eval': 'error',
        '@mikrojs/no-intl': 'error',
        '@mikrojs/no-temporal': 'error',
        '@mikrojs/no-sparse-arrays': 'warn',
      },
    },
  ),
})

export default plugin
