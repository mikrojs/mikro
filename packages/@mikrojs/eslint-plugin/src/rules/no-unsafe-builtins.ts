import {ESLintUtils, type TSESLint, type TSESTree} from '@typescript-eslint/utils'

import {DEFAULT_CONFIG_FILES} from './no-device-imports-in-config.js'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikro/blob/main/docs/rules/${name}.md`,
)

// Keep in sync with safe_builtins in mik_result.cpp
const GLOBAL_FUNCTIONS = new Set([
  'atob',
  'btoa',
  'decodeURI',
  'decodeURIComponent',
  'encodeURI',
  'encodeURIComponent',
  'RegExp',
])
const MEMBER_FUNCTIONS: Record<string, Set<string>> = {
  JSON: new Set(['parse', 'stringify']),
  String: new Set(['fromCodePoint']),
}

type MessageIds = 'throwingBuiltin' | 'useSafe' | 'notABuiltin'

export const noUnsafeBuiltins = createRule<[], MessageIds>({
  name: 'no-unsafe-builtins',
  meta: {
    type: 'problem',
    hasSuggestions: true,
    docs: {
      description:
        'Disallow direct calls to builtins that throw on bad input. Use safe() from mikro/result to get a Result.',
    },
    messages: {
      throwingBuiltin:
        '{{name}}() throws on bad input. Call it through safe() from mikro/result to get a Result.',
      useSafe: 'Call it through safe()',
      notABuiltin:
        'safe() only calls builtins that throw on bad input, such as JSON.parse. Other functions throw a TypeError.',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    // Config files run in Node, where safe() doesn't exist
    const basename = context.filename.split(/[\\/]/).at(-1)!
    if (DEFAULT_CONFIG_FILES.includes(basename)) return {}

    const sourceCode = context.sourceCode
    let safeName: string | undefined
    const namespaceNames = new Set<string>()
    let resultImport: TSESTree.ImportDeclaration | undefined

    function resolve(name: string, node: TSESTree.Node): TSESLint.Scope.Variable | undefined {
      for (let scope: TSESLint.Scope.Scope | null = sourceCode.getScope(node); scope;) {
        const variable = scope.set.get(name)
        if (variable) return variable
        scope = scope.upper
      }
      return undefined
    }

    function isGlobal(node: TSESTree.Identifier): boolean {
      const variable = resolve(node.name, node)
      return !variable || variable.defs.length === 0
    }

    /** Whether `name` at `node` is an import from mikro/result, not shadowed. */
    function isImported(name: string, node: TSESTree.Node): boolean {
      return !!resolve(name, node)?.defs.some((d) => d.type === 'ImportBinding')
    }

    /** `atob`, `JSON.parse` and so on, when they refer to the real builtin. */
    function builtinName(node: TSESTree.Node): string | undefined {
      if (node.type === 'Identifier') {
        return GLOBAL_FUNCTIONS.has(node.name) && isGlobal(node) ? node.name : undefined
      }
      if (
        node.type === 'MemberExpression' &&
        !node.computed &&
        !node.optional &&
        node.object.type === 'Identifier' &&
        node.property.type === 'Identifier' &&
        MEMBER_FUNCTIONS[node.object.name]?.has(node.property.name) &&
        isGlobal(node.object)
      ) {
        return `${node.object.name}.${node.property.name}`
      }
      return undefined
    }

    function isSafe(callee: TSESTree.Node): boolean {
      if (callee.type === 'Identifier') {
        return callee.name === safeName && isImported(callee.name, callee)
      }
      return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        namespaceNames.has(callee.object.name) &&
        isImported(callee.object.name, callee) &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'safe'
      )
    }

    /** How to call safe at `node`, or undefined when the name is taken. */
    function safeCallee(node: TSESTree.Node): {callee: string; addImport: boolean} | undefined {
      if (safeName && isImported(safeName, node)) return {callee: safeName, addImport: false}
      for (const ns of namespaceNames) {
        if (isImported(ns, node)) return {callee: `${ns}.safe`, addImport: false}
      }
      return resolve('safe', node) ? undefined : {callee: 'safe', addImport: true}
    }

    function isLiteral(node: TSESTree.Node): boolean {
      return (
        node.type === 'Literal' ||
        (node.type === 'TemplateLiteral' && node.expressions.length === 0)
      )
    }

    /** Strings, numbers, booleans, null, and object or array literals of those. */
    function isPlainData(node: TSESTree.Node | null): boolean {
      if (!node) return true // array hole
      switch (node.type) {
        case 'Literal':
          return !('bigint' in node)
        case 'TemplateLiteral':
          return node.expressions.length === 0
        case 'UnaryExpression':
          return (
            node.operator === '-' &&
            node.argument.type === 'Literal' &&
            typeof node.argument.value === 'number'
          )
        case 'ArrayExpression':
          return node.elements.every((e) => e?.type !== 'SpreadElement' && isPlainData(e))
        case 'ObjectExpression':
          return node.properties.every(
            (p) =>
              p.type === 'Property' &&
              p.kind === 'init' &&
              !p.method &&
              !p.computed &&
              isPlainData(p.value),
          )
        default:
          return false
      }
    }

    function check(node: TSESTree.CallExpression | TSESTree.NewExpression) {
      if (node.type === 'CallExpression' && isSafe(node.callee)) {
        const fn = node.arguments[0]
        if (!fn || !builtinName(fn)) {
          context.report({node: fn ?? node, messageId: 'notABuiltin'})
        }
        return
      }

      const name = builtinName(node.callee)
      if (!name) return
      // A literal pattern is checked by whoever wrote it
      if (name === 'RegExp' && node.arguments.every(isLiteral)) return
      // Plain data has no cycles, BigInts or callbacks, so it can't throw
      if (name === 'JSON.stringify' && node.arguments.every(isPlainData)) return

      const target = safeCallee(node)
      context.report({
        node,
        messageId: 'throwingBuiltin',
        data: {name},
        suggest: target
          ? [
              {
                messageId: 'useSafe',
                fix: (fixer) => {
                  const args = [node.callee, ...node.arguments].map((n) => sourceCode.getText(n))
                  const fixes = [fixer.replaceText(node, `${target.callee}(${args.join(', ')})`)]
                  if (target.addImport) fixes.push(addImport(fixer))
                  return fixes
                },
              },
            ]
          : [],
      })
    }

    function addImport(fixer: TSESLint.RuleFixer): TSESLint.RuleFix {
      const specifiers = resultImport?.specifiers.filter((s) => s.type === 'ImportSpecifier')
      const last = specifiers?.at(-1)
      if (last) return fixer.insertTextAfter(last, ', safe')
      const first = sourceCode.ast.body[0]!
      return fixer.insertTextBefore(first, "import {safe} from 'mikro/result'\n")
    }

    return {
      Program(program) {
        for (const statement of program.body) {
          if (
            statement.type !== 'ImportDeclaration' ||
            statement.source.value !== 'mikro/result' ||
            statement.importKind === 'type'
          ) {
            continue
          }
          for (const s of statement.specifiers) {
            if (s.type === 'ImportNamespaceSpecifier') {
              namespaceNames.add(s.local.name)
            } else if (s.type === 'ImportSpecifier' && s.importKind !== 'type') {
              resultImport ??= statement
              const imported = s.imported.type === 'Identifier' ? s.imported.name : s.imported.value
              if (imported === 'safe') safeName = s.local.name
            }
          }
        }
      },
      CallExpression: check,
      NewExpression: check,
    }
  },
})
