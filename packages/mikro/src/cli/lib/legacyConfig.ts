/**
 * The package.json config namespace was renamed from `mikrojs` to `mikro`.
 * There is no compatibility shim: a lingering `mikrojs` key is almost always a
 * stale config that would otherwise be silently ignored, so we fail loudly with
 * migration guidance instead.
 */
export function assertNoLegacyMikroConfig(pkg: {mikrojs?: unknown}, source: string): void {
  if (pkg.mikrojs !== undefined) {
    throw new Error(
      `The "mikrojs" config key in ${source} was renamed to "mikro". ` +
        `Rename it to "mikro" to continue.`,
    )
  }
}
