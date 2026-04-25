import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikrojs/blob/main/docs/rules/${name}.md`,
)

export const noTemporal = createRule({
  name: 'no-temporal',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow use of the Temporal API. QuickJS-NG does not support Temporal and will throw at runtime.',
    },
    messages: {
      noTemporal:
        'The Temporal API is not available in QuickJS-NG. Use Date or a lightweight library instead.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      'MemberExpression[object.name="Temporal"]'(node: TSESTree.MemberExpression) {
        context.report({node, messageId: 'noTemporal'})
      },
    }
  },
})
