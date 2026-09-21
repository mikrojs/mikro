import {tsPlugin} from '@sveltejs/acorn-typescript'
import {Parser as AcornParser} from 'acorn'
import {type AsyncHandler, asyncWalk} from 'estree-walker'

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

/** One import of one specifier. A specifier imported twice in a file is two refs. */
export interface ImportRef {
  specifier: string
  /** `static`: an import or export-from declaration. `dynamic`: an import() expression. */
  kind: 'static' | 'dynamic'
  /** Where the specifier is in the source, between its quotes. Absent when the
   *  specifier was computed from an expression. */
  range?: [start: number, end: number]
}

export interface AnalyzeResult {
  imports: ImportRef[]
  /** Set when the file did not parse; `imports` is then empty. */
  parseError?: string
}

export default async function analyze(id: string, code: string): Promise<AnalyzeResult> {
  const imports: ImportRef[] = []

  let ast: Node

  try {
    ast = Parser.parse(code, {
      ecmaVersion: 2026,
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      // Keeps the offsets of `range` valid for a file with a shebang.
      allowHashBang: true,
    }) as unknown as Node
  } catch (e: unknown) {
    const parseError = `Failed to parse ${id} as module:\n${e instanceof Error ? e.message : String(e)}`
    return {imports, parseError}
  }

  // Process top-level ESM declarations
  if (isAst(ast)) {
    for (const decl of ast.body as Node[]) {
      // `import type` / `export type ... from` is erased by every TypeScript
      // transform, so nothing is imported. Inline `type` specifiers do not
      // qualify: verbatimModuleSyntax keeps those as a side-effect import.
      if (decl.importKind === 'type' || decl.exportKind === 'type') continue
      if (
        decl.type === 'ImportDeclaration' ||
        decl.type === 'ExportNamedDeclaration' ||
        decl.type === 'ExportAllDeclaration'
      ) {
        if (!decl.source) continue
        imports.push({
          specifier: String(decl.source.value),
          kind: 'static',
          range: [decl.source.start + 1, decl.source.end - 1],
        })
      }
    }
  }

  function addComputed(specifier: unknown) {
    if (typeof specifier !== 'string') return
    const known = imports.some(
      (ref) => ref.kind === 'dynamic' && ref.range === undefined && ref.specifier === specifier,
    )
    if (!known) imports.push({specifier, kind: 'dynamic'})
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

    if (expression.type === 'Literal' && typeof expression.value === 'string') {
      imports.push({
        specifier: expression.value,
        kind: 'dynamic',
        range: [expression.start + 1, expression.end - 1],
      })
      return
    }

    const computed = await computePureStaticValue(expression, true)
    if (!computed) return

    if ('value' in computed) {
      addComputed(computed.value)
    } else if ('ifTrue' in computed) {
      addComputed(computed.ifTrue)
      addComputed(computed.else)
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

  return {imports}
}

function isAst(ast: unknown): ast is Ast {
  return typeof ast === 'object' && ast !== null && 'body' in ast
}
