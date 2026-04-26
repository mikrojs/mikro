import js from '@eslint/js'
import mikrojs from '@mikrojs/eslint-plugin'
import importPlugin from 'eslint-plugin-import'
import packageJson from 'eslint-plugin-package-json'
import reactHooks from 'eslint-plugin-react-hooks'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default [
  // Ignore patterns
  {
    ignores: [
      'esp32/managed_components/**',
      'packages/@mikrojs/quickjs/deps/**',
      'packages/@mikrojs/analyze-imports/test/**',
      'packages/@mikrojs/firmware/index.d.ts',
      '**/dist/**',
      '**/build/**',
      '**/build-test/**',
      '**/.mikro/**',
      '**/node_modules/**',
      'packages/create-mikrojs/src/templates/**',
      '**/vitest.config.ts',
      'packages/@mikrojs/native/src/__test__/**',
      'docs/.vitepress/dist/**',
      'docs/.vitepress/cache/**',
      'coverage/**',
      'temp/**',
      'pack-test/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Plain .js files are Node scripts (build tooling). TS files get globals
  // from @types/node via the compiler; this block covers everything else.
  {
    files: ['**/*.js'],
    languageOptions: {globals: globals.node},
  },

  // TypeScript-specific tweaks (parser options, type-aware rules, relaxations)
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {argsIgnorePattern: '^_', varsIgnorePattern: '^_'},
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'inline-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },

  ...mikrojs.configs.recommended,

  packageJson.configs.recommended,
  // docs uses "vitepress": "next" (dist-tag), which is valid but flagged
  {
    files: ['docs/package.json'],
    rules: {
      'package-json/valid-devDependencies': 'off',
    },
  },

  // Import sorting and deduplication
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: {
      'simple-import-sort': simpleImportSort,
      import: importPlugin,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'import/no-duplicates': ['error', {'prefer-inline': true}],
    },
  },

  // React hooks (Ink CLI)
  {
    files: ['packages/mikrojs/**/*.tsx'],
    plugins: {'react-hooks': reactHooks},
    rules: reactHooks.configs['recommended-latest'].rules,
  },

  // Workspace-level style rules
  {
    rules: {
      'prefer-const': 'error',
      'no-debugger': 'error',
      'no-console': 'error',
    },
  },

  // Override: tsconfigRootDir for this workspace
  {
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Examples, dev apps, and build tooling use console as their primary output API
  {
    files: [
      'examples/**/app/**',
      'dev/**/app/**',
      'bench-site/**/*.ts',
      'packages/@mikrojs/firmware/scripts/**',
    ],
    rules: {
      'no-console': 'off',
    },
  },

  // Disable mikrojs error-handling rules for internal packages
  // (runtime modules intentionally use throw, try/catch at the boundary layer)
  {
    files: ['bench-site/**/*.ts', 'docs/**/*.ts', 'packages/**/*.ts', 'packages/**/*.tsx'],
    rules: {
      '@mikrojs/no-unhandled-result': 'off',
      '@mikrojs/no-throw': 'off',
      '@mikrojs/no-try-catch': 'off',
      '@mikrojs/no-promise-reject': 'off',
      '@mikrojs/no-dot-catch': 'off',
    },
  },
]
