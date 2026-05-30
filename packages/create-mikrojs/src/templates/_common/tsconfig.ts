export function tsconfigJson(extraIncludes: readonly string[] = []): string {
  const includes = [...extraIncludes, 'mikro.config.ts', 'app/**/*']
  return `{
  "extends": "mikrojs/tsconfig",
  "include": ${inlineStringArray(includes)}
}
`
}

function inlineStringArray(items: readonly string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`
}
