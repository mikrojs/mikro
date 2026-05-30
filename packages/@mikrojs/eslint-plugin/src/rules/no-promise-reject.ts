import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikro/blob/main/docs/rules/${name}.md`,
)

export const noPromiseReject = createRule({
  name: 'no-promise-reject',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow Promise.reject() and reject() calls. Use Result types for async errors.',
    },
    messages: {
      noPromiseReject: 'Do not use Promise.reject(). Return err() from mikrojs/result instead.',
      noRejectCall: 'Do not call reject(). Return err() from mikrojs/result instead.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    const rejectParams = new Set<string>()

    return {
      // Track reject parameter names from new Promise((resolve, reject) => ...)
      'NewExpression[callee.name="Promise"] > ArrowFunctionExpression'(
        node: TSESTree.ArrowFunctionExpression,
      ) {
        const param = node.params[1]
        if (param?.type === 'Identifier') {
          rejectParams.add(param.name)
        }
      },
      'NewExpression[callee.name="Promise"] > FunctionExpression'(
        node: TSESTree.FunctionExpression,
      ) {
        const param = node.params[1]
        if (param?.type === 'Identifier') {
          rejectParams.add(param.name)
        }
      },

      // Flag Promise.reject(...)
      'CallExpression > MemberExpression[object.name="Promise"][property.name="reject"]'(
        node: TSESTree.MemberExpression,
      ) {
        context.report({node: node.parent as TSESTree.CallExpression, messageId: 'noPromiseReject'})
      },

      // Flag reject(...) calls where reject is a Promise constructor parameter
      'CallExpression[callee.type="Identifier"]'(node: TSESTree.CallExpression) {
        if (node.callee.type === 'Identifier' && rejectParams.has(node.callee.name)) {
          context.report({node, messageId: 'noRejectCall'})
        }
      },
    }
  },
})
