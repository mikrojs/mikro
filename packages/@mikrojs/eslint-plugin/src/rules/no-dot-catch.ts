import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikrojs/blob/main/docs/rules/${name}.md`,
)

export const noDotCatch = createRule({
  name: 'no-dot-catch',
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow .catch() on promises. Use Result types for async error handling.',
    },
    messages: {
      noDotCatch: 'Do not use .catch(). Async errors should be returned as Result types.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      'CallExpression > MemberExpression[property.name="catch"]'(node: TSESTree.MemberExpression) {
        context.report({node: node.parent as TSESTree.CallExpression, messageId: 'noDotCatch'})
      },
    }
  },
})
