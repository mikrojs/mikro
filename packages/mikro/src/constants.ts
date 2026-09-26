import {isTableModule} from './cli/lib/capabilities.js'

/** Check if a module specifier matches a firmware builtin pattern.
 * `mikro/<name>` builtins come from the capability table
 * (@mikrojs/native/runtime/modules.json), internal modules included: the
 * on-device loader resolves those too.
 * `native:` is a firmware-only scheme: it never resolves to a file on disk, so
 * it is always a builtin (the on-device loader binds it to the registered native
 * modules). This lets app-local native code be imported without packaging it. */
export function isBuiltinModule(id: string): boolean {
  if (id.startsWith('native:') || id === 'mikro') return true
  return id.startsWith('mikro/') && isTableModule(id.slice('mikro/'.length))
}
