export function tsconfigJson(chip: string, extraIncludes: readonly string[] = []): string {
  const includes = [...extraIncludes, 'mikro.config.ts', 'app/**/*']
  return `{
  "extends": "mikro/tsconfig/${chip}-generic",
  "include": ${inlineStringArray(includes)}
}
`
}

function inlineStringArray(items: readonly string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`
}
