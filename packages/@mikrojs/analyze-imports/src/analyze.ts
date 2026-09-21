import {tsPlugin} from '@sveltejs/acorn-typescript'
import {Parser as AcornParser} from 'acorn'
import {type AsyncHandler, asyncWalk} from 'estree-walker'

import type {Tracer} from './trace.js'
import {evaluate} from './utils/static-eval.js'
import type {Ast, EvaluatedValue, Node, StaticValue} from './utils/types.js'

const Parser = AcornParser.extend(tsPlugin())

const globalBindings: Record<string, unknown> = {
  URL: URL,
  Object: {
    assign: Object.assign,
  },
}

globalBindings['globalThis'] = globalBindings

export interface AnalyzeResult {
  imports: Set<string>
  /** Specifiers imported via static declarations (import/export-from). */
  staticImports: Set<string>
  /** Specifiers imported via dynamic import() expressions. */
  dynamicImports: Set<string>
}

export default async function analyze(
  id: string,
  code: string,
  job: Tracer,
): Promise<AnalyzeResult> {
  const imports = new Set<string>()
  const staticImports = new Set<string>()
  const dynamicImports = new Set<string>()

  // remove shebang
  code = code.replace(/^#![^\n\r]*[\r\n]/, '')

  let ast: Node

  try {
    ast = Parser.parse(code, {
      ecmaVersion: 2026,
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
    }) as unknown as Node
  } catch (e: unknown) {
    job.warnings.add(
      new Error(`Failed to parse ${id} as module:\n${e instanceof Error ? e.message : String(e)}`),
    )
    return {imports, staticImports, dynamicImports}
  }

  // Process top-level ESM declarations
  if (isAst(ast)) {
    for (const decl of ast.body as Node[]) {
      // `import type` / `export type ... from` is erased by every TypeScript
      // transform, so nothing is imported. Inline `type` specifiers do not
      // qualify: verbatimModuleSyntax keeps those as a side-effect import.
      if (decl.importKind === 'type' || decl.exportKind === 'type') continue
      if (decl.type === 'ImportDeclaration') {
        const source = String(decl.source.value)
        imports.add(source)
        staticImports.add(source)
      } else if (decl.type === 'ExportNamedDeclaration' || decl.type === 'ExportAllDeclaration') {
        if (decl.source) {
          const source = String(decl.source.value)
          imports.add(source)
          staticImports.add(source)
        }
      }
    }
  }

  async function computePureStaticValue(expr: Node, computeBranches = true) {
    const vars: Record<string, EvaluatedValue> = Object.create(null)
    Object.keys(globalBindings).forEach((name) => {
      vars[name] = {value: globalBindings[name]} as StaticValue
    })
    return evaluate(expr, vars, computeBranches)
  }

  async function processImportArg(expression: Node) {
    if (expression.type === 'ConditionalExpression') {
      await processImportArg(expression.consequent)
      await processImportArg(expression.alternate)
      return
    }
    if (expression.type === 'LogicalExpression') {
      await processImportArg(expression.left)
      await processImportArg(expression.right)
      return
    }

    const computed = await computePureStaticValue(expression, true)
    if (!computed) return

    if ('value' in computed && typeof computed.value === 'string') {
      imports.add(computed.value)
      dynamicImports.add(computed.value)
    } else if ('ifTrue' in computed) {
      if (typeof computed.ifTrue === 'string') {
        imports.add(computed.ifTrue)
        dynamicImports.add(computed.ifTrue)
      }
      if (typeof computed.else === 'string') {
        imports.add(computed.else)
        dynamicImports.add(computed.else)
      }
    }
  }

  await asyncWalk(ast as Parameters<typeof asyncWalk>[0], {
    async enter(this: ThisParameterType<AsyncHandler>, _node: unknown, _parent: unknown) {
      const node: Node = _node as Node
      const parent: Node = _parent as Node

      if (!parent) return

      if (node.type === 'ImportExpression') {
        await processImportArg(node.source)
      }
    },
  })

  return {imports, staticImports, dynamicImports}
}

function isAst(ast: unknown): ast is Ast {
  return typeof ast === 'object' && ast !== null && 'body' in ast
}
