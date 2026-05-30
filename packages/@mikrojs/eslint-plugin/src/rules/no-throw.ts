import {ESLintUtils} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikro/blob/main/docs/rules/${name}.md`,
)

export const noThrow = createRule({
  name: 'no-throw',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow throw statements. Use Result types for expected errors and panic() for unrecoverable situations.',
    },
    messages: {
      noThrow:
        'Do not use throw. Use Result types for expected errors, or panic() from mikrojs/sys for unrecoverable situations.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      ThrowStatement(node) {
        context.report({node, messageId: 'noThrow'})
      },
    }
  },
})
