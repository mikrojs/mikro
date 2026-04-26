export const eslintConfig = `\
import js from '@eslint/js'
import mikrojs from '@mikrojs/eslint-plugin'
import tseslint from 'typescript-eslint'

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...mikrojs.configs.recommended,
]
`
