import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikrojs/blob/main/docs/rules/${name}.md`,
)

export const noTryCatch = createRule({
  name: 'no-try-catch',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow try/catch blocks. try/finally for cleanup is allowed.',
    },
    messages: {
      noTryCatch:
        'Do not use try/catch. Use Result types for error handling. try/finally for cleanup is allowed.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      TryStatement(node: TSESTree.TryStatement) {
        if (node.handler) {
          context.report({node: node.handler, messageId: 'noTryCatch'})
        }
      },
    }
  },
})
