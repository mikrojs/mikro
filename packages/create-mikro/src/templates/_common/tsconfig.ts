/** A chip's preset narrows the types to that chip's features; without one,
 *  the default preset allows every feature. */
export function tsconfigJson(chip: string | undefined, extraIncludes: readonly string[] = []): string {
  const includes = [...extraIncludes, 'mikro.config.ts', 'app/**/*']
  return `{
  "extends": "mikro/tsconfig${chip === undefined ? '' : `/${chip}-generic`}",
  "include": ${inlineStringArray(includes)}
}
`
}

function inlineStringArray(items: readonly string[]): string {
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`
}
