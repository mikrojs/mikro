export function tsconfigJson(extraIncludes: readonly string[] = []): string {
  const includes = [...extraIncludes, 'mikro.config.ts', 'app/**/*']
  return `{
  "include": ${inlineStringArray(includes)},
  "compilerOptions": {
    "module": "nodenext",
    "target": "es2024",
    "lib": ${inlineStringArray(['es2024'])},
    "noEmit": true,
    "types": ${inlineStringArray(['mikrojs/runtime'])},
    "sourceMap": true,
    "noUncheckedIndexedAccess": true,
    "allowUnreachableCode": false,
    "erasableSyntaxOnly": true,
    "strict": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "noUncheckedSideEffectImports": true,
    "moduleDetection": "force",
    "jsx": "preserve",
    "skipLibCheck": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  }
}
`
}

function inlineStringArray(items: readonly string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`
}
