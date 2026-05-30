import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikro/blob/main/docs/rules/${name}.md`,
)

export const noBigInt = createRule({
  name: 'no-bigint',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow use of BigInt. The mikrojs runtime omits the BigInt intrinsic to save memory, so it is not available at runtime.',
    },
    messages: {
      noBigInt:
        'BigInt is not available in the mikrojs runtime. Use Number, typed arrays, or string-based math instead.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const report = (node: TSESTree.Node) => context.report({node, messageId: 'noBigInt'})
    return {
      'Literal[bigint]': report,
      'CallExpression[callee.name="BigInt"]': report,
      'MemberExpression[object.name="BigInt"]': report,
      'NewExpression[callee.name=/^Big(Int|Uint)64Array$/]': report,
      'MemberExpression[object.name=/^Big(Int|Uint)64Array$/]': report,
    }
  },
})
