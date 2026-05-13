import type {TsConfigJson} from 'type-fest'

export const tsconfig: TsConfigJson = {
  include: ['mikro.config.ts', 'app/**/*'],
  compilerOptions: {
    module: 'nodenext',
    target: 'es2024',
    lib: ['es2024'],
    noEmit: true,
    types: ['mikrojs/runtime'],
    sourceMap: true,
    noUncheckedIndexedAccess: true,
    allowUnreachableCode: false,
    erasableSyntaxOnly: true,
    strict: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    noUncheckedSideEffectImports: true,
    moduleDetection: 'force',
    jsx: 'preserve',
    skipLibCheck: true,
    noFallthroughCasesInSwitch: true,
    noUnusedLocals: true,
    forceConsistentCasingInFileNames: true,
    resolveJsonModule: true,
  },
}
