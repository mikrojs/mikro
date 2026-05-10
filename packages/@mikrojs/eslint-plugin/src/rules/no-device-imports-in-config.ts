import {ESLintUtils, type TSESTree} from '@typescript-eslint/utils'

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/mikrojs/mikrojs/blob/main/docs/rules/${name}.md`,
)

const DEFAULT_CONFIG_FILES = ['mikro.config.ts', 'mikro.config.js']

type Options = [{configFiles?: string[]}]

export const noDeviceImportsInConfig = createRule<Options, 'noDeviceImport'>({
  name: 'no-device-imports-in-config',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow on-device module imports (mikrojs/*) in build-time config files. These run in Node, not on-device.',
    },
    messages: {
      noDeviceImport:
        'Cannot import on-device module "{{source}}" in a build-time config file. Only the bare `mikrojs` import is allowed here; `mikrojs/*` subpaths are device-only.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          configFiles: {
            type: 'array',
            items: {type: 'string'},
          },
        },
        additionalProperties: false,
      },
    ],
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const configFiles = options.configFiles ?? DEFAULT_CONFIG_FILES
    const filename = context.filename
    const lastSep = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'))
    const basename = lastSep >= 0 ? filename.slice(lastSep + 1) : filename
    if (!configFiles.includes(basename)) {
      return {}
    }

    function check(source: TSESTree.StringLiteral | null | undefined, node: TSESTree.Node) {
      if (!source || typeof source.value !== 'string') return
      if (source.value.startsWith('mikrojs/')) {
        context.report({node, messageId: 'noDeviceImport', data: {source: source.value}})
      }
    }

    return {
      ImportDeclaration(node) {
        check(node.source, node)
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
          check(node.source as TSESTree.StringLiteral, node)
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source, node)
      },
      ExportAllDeclaration(node) {
        check(node.source, node)
      },
    }
  },
})
