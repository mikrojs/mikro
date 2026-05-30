import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikro/blob/main/docs/rules/${name}.md`,
)

function hasOkBooleanLiteral(
  type: import('typescript').Type,
  checker: import('typescript').TypeChecker,
): boolean {
  const okProp = type.getProperty('ok')
  if (!okProp) return false
  const decl = okProp.valueDeclaration ?? okProp.declarations?.[0]
  if (!decl) return false
  const okType = checker.getTypeOfSymbolAtLocation(okProp, decl)
  const intrinsicName = (okType as any).intrinsicName as string | undefined
  return intrinsicName === 'true' || intrinsicName === 'false'
}

function containsResultLikeType(
  type: import('typescript').Type,
  checker: import('typescript').TypeChecker,
): boolean {
  // Check if the type (or any member of a union) has an {ok: true} or {ok: false}
  // property. This catches:
  // - Result<T, E>          → {ok: true} | {ok: false}
  // - ErrResult<E> | void   → {ok: false} | void — error still needs handling
  // - Result<T, E> | undefined → same principle
  const members = (type as any).types as import('typescript').Type[] | undefined
  if (members) {
    return members.some((m) => hasOkBooleanLiteral(m, checker))
  }
  return hasOkBooleanLiteral(type, checker)
}

function unwrapPromise(type: import('typescript').Type): import('typescript').Type {
  const symbol = type.getSymbol()
  if (symbol?.name === 'Promise') {
    const typeArgs = (type as import('typescript').TypeReference).typeArguments
    if (typeArgs && typeArgs.length >= 1) return typeArgs[0]!
  }
  return type
}

function isResultOrPromiseResult(
  type: import('typescript').Type,
  checker: import('typescript').TypeChecker,
): boolean {
  if (containsResultLikeType(type, checker)) return true
  const unwrapped = unwrapPromise(type)
  if (unwrapped !== type && containsResultLikeType(unwrapped, checker)) return true
  return false
}

export const noUnhandledResult = createRule({
  name: 'no-unhandled-result',
  meta: {
    type: 'problem',
    docs: {
      description: 'Require Result return values to be handled',
    },
    messages: {
      unhandled: 'Result must be handled — errors will be silently ignored.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      ExpressionStatement(node: TSESTree.ExpressionStatement) {
        const services = ESLintUtils.getParserServices(context)
        const checker = services.program.getTypeChecker()

        if (node.expression.type === 'CallExpression') {
          const type = services.getTypeAtLocation(node.expression)
          if (isResultOrPromiseResult(type, checker)) {
            context.report({node: node.expression, messageId: 'unhandled'})
          }
        } else if (
          node.expression.type === 'AwaitExpression' &&
          node.expression.argument.type === 'CallExpression'
        ) {
          // Check the awaited type (the AwaitExpression's type, not the Promise)
          const awaitedType = services.getTypeAtLocation(node.expression)
          if (containsResultLikeType(awaitedType, checker)) {
            context.report({node: node.expression.argument, messageId: 'unhandled'})
            return
          }
          // Also check the call's return type (Promise<Result>)
          const callType = services.getTypeAtLocation(node.expression.argument)
          if (isResultOrPromiseResult(callType, checker)) {
            context.report({node: node.expression.argument, messageId: 'unhandled'})
          }
        }
      },
    }
  },
})
