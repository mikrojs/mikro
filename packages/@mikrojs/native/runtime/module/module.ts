import {isUnloadableNamespace, unloadNamespace} from 'native:mikro/sys'

/**
 * Load a dynamically imported module, run `use` with it, then unload it and
 * reclaim its memory. Use for app phases that pull in code you won't need again:
 *
 * ```ts
 * const status = await withUnload(
 *   import('./phases/modem.js'),
 *   (modem) => modem.runPhase(input),
 * )
 * // the modem phase is unloaded and reclaimed by the time this resolves
 * ```
 *
 * The module is unloaded when `use` returns (or throws), including any transitive
 * dependency whose only importer was this module. Don't return one of the
 * module's exports from `use`; that keeps the module alive. Throws if the
 * resolved value isn't an unloadable module namespace (e.g. a builtin
 * `mikrojs/*` or `native:*` module).
 *
 * This is non-standard: standard JavaScript modules stay loaded for the life of
 * the program, and a later `import` re-evaluates an unloaded module from scratch.
 */
export async function withUnload<T extends object, R>(
  mod: Promise<T>,
  use: (mod: T) => R | Promise<R>,
): Promise<R> {
  const ns = await mod
  if (!isUnloadableNamespace(ns)) {
    throw new TypeError('withUnload() expects an unloadable module namespace')
  }
  try {
    return await use(ns)
  } finally {
    unloadNamespace(ns)
  }
}
