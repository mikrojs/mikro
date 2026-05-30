/** Load a dynamically imported module, run `use` with it, then unload it and
 *  reclaim its memory:
 *
 *  ```ts
 *  const status = await withUnload(
 *    import('./phases/modem.js'),
 *    (modem) => modem.runPhase(input),
 *  )
 *  ```
 *
 *  The module (and any transitive dependency whose only importer was it) is
 *  unloaded when `use` returns or throws. Don't return one of the module's
 *  exports from `use`; that keeps it alive. Throws if the resolved value isn't
 *  an unloadable module namespace (e.g. a builtin `mikrojs/*` or `native:*`).
 *
 *  Non-standard: standard JavaScript modules stay loaded for the life of the
 *  program, and a later `import` re-evaluates an unloaded module from scratch. */
export declare function withUnload<T extends object, R>(
  mod: Promise<T>,
  use: (mod: T) => R | Promise<R>,
): Promise<R>
