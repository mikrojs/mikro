import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikro/blob/main/docs/rules/${name}.md`,
)

export const noSparseArrays = createRule({
  name: 'no-sparse-arrays',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow sparse arrays. QuickJS optimizes dense arrays — holes cause a fallback to a slower object-based representation.',
    },
    messages: {
      noSparse:
        'Avoid sparse arrays (holes). QuickJS optimizes dense arrays — use explicit undefined values or filter instead.',
      noDeleteElement:
        'Avoid delete on array elements — it creates holes. Use Array.prototype.splice() or filter instead.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      // Catch [1,,3] — array literals with elisions
      ArrayExpression(node: TSESTree.ArrayExpression) {
        for (const element of node.elements) {
          if (element === null) {
            context.report({node, messageId: 'noSparse'})
            return
          }
        }
      },
      // Catch delete arr[i]
      UnaryExpression(node: TSESTree.UnaryExpression) {
        if (
          node.operator === 'delete' &&
          node.argument.type === 'MemberExpression' &&
          node.argument.computed
        ) {
          context.report({node, messageId: 'noDeleteElement'})
        }
      },
    }
  },
})
