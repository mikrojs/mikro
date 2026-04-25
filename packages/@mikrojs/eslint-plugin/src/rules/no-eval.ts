import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikrojs/blob/main/docs/rules/${name}.md`,
)

export const noEval = createRule({
  name: 'no-eval',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow eval() and new Function(). Runtime compilation is expensive on constrained devices.',
    },
    messages: {
      noEval:
        'Do not use eval(). Runtime compilation is expensive on constrained devices — use pre-compiled modules instead.',
      noNewFunction:
        'Do not use new Function(). Runtime compilation is expensive on constrained devices — use pre-compiled modules instead.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      'CallExpression[callee.name="eval"]'(node: TSESTree.CallExpression) {
        context.report({node, messageId: 'noEval'})
      },
      'NewExpression[callee.name="Function"]'(node: TSESTree.NewExpression) {
        context.report({node, messageId: 'noNewFunction'})
      },
    }
  },
})
