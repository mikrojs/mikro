import {isTableModule} from './cli/lib/capabilities.js'

/** Module patterns that are always firmware builtins (not deployed or bundled
 * with user code). Used as esbuild `external` patterns; the same list is
 * duplicated in @mikrojs/native/scripts/bundle-runtime.js (CMake build
 * context) and must be kept in sync manually there.
 * Note: @mikrojs/* packages are NOT automatically builtins. Only packages with
 * native code (those that export ./cmake) are firmware builtins; the build
 * resolves that dynamically, and pure JS @mikrojs/* packages are bundled and
 * deployed with the user's app. */
export const BUILTIN_EXTERNALS = ['mikro', 'mikro/*', '@mikrojs/*']

/** Check if a module specifier matches a firmware builtin pattern.
 * `mikro/<name>` builtins come from the capability table
 * (@mikrojs/native/runtime/modules.json), internal modules included: the
 * on-device loader resolves those too.
 * Note: @mikrojs/* packages are only builtins if they have native code.
 * The trace resolver handles this dynamically by checking for ./cmake exports.
 * `native:` is a firmware-only scheme: it never resolves to a file on disk, so
 * it is always a builtin (the on-device loader binds it to the registered native
 * modules). This lets app-local native code be imported without packaging it. */
export function isBuiltinModule(id: string): boolean {
  if (id.startsWith('native:') || id === 'mikro') return true
  return id.startsWith('mikro/') && isTableModule(id.slice('mikro/'.length))
}
