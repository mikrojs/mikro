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
export const BUILTIN_EXTERNALS = ['mikro', 'mikro/*', '@mikrojs/*']

/** Check if a module specifier matches a firmware builtin pattern.
 * Note: @mikrojs/* packages are only builtins if they have native code.
 * The trace resolver handles this dynamically by checking for ./cmake exports.
 * `native:` is a firmware-only scheme: it never resolves to a file on disk, so
 * it is always a builtin (the on-device loader binds it to the registered native
 * modules). This lets app-local native code be imported without packaging it. */
export function isBuiltinModule(id: string): boolean {
  return (
    id.startsWith('native:') || BUILTINS.includes(id) || id === 'mikro' || id.startsWith('mikro/')
  )
}
