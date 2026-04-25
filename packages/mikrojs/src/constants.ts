export const BUILTINS = [
  'cbor',
  'fetch',
  'fs',
  'pin',
  'i2c',
  'kv',
  'result',
  'schema',
  'sleep',
  'sys',
  'wifi',
]

/** Module patterns that are always firmware builtins (not deployed or bundled with user code).
 * Shared by the CLI build/deploy and esbuild config. The same patterns are used in
 * bundle-runtime.js (CMake build context) and must be kept in sync manually there.
 * Note: @mikrojs/* packages are NOT automatically builtins. Only packages with native
 * code (those that export ./cmake) are firmware builtins. Pure JS @mikrojs/* packages
 * are bundled and deployed with the user's app. */
export const BUILTIN_EXTERNALS = ['mikrojs', 'mikrojs/*', '@mikrojs/*']

/** Check if a module specifier matches a firmware builtin pattern.
 * Note: @mikrojs/* packages are only builtins if they have native code.
 * The trace resolver handles this dynamically by checking for ./cmake exports. */
export function isBuiltinModule(id: string): boolean {
  return BUILTINS.includes(id) || id === 'mikrojs' || id.startsWith('mikrojs/')
}
