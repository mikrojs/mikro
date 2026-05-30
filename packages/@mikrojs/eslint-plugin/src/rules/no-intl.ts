import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikro/blob/main/docs/rules/${name}.md`,
)

export const noIntl = createRule({
  name: 'no-intl',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow use of the Intl API. QuickJS-NG does not support Intl and will throw at runtime.',
    },
    messages: {
      noIntl:
        'The Intl API is not available in QuickJS-NG. Use manual formatting or a lightweight library instead.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      'MemberExpression[object.name="Intl"]'(node: TSESTree.MemberExpression) {
        context.report({node, messageId: 'noIntl'})
      },
    }
  },
})
