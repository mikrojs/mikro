import modulesJson from '@mikrojs/native/runtime/modules.json' with {type: 'json'}

/** One entry of the builtin capability table
 * (@mikrojs/native/runtime/modules.json). */
interface CapabilityModule {
  /** Builtin module name; the import specifier is `mikro/<name>`. */
  name: string
  /** Self-registering native module id backing this builtin. */
  native?: string
  /** Firmware feature gating the module (absent = always available). */
  feature?: string
  /** `false` marks internal modules with no `mikro/<name>` export subpath. */
  public?: boolean
}

const MODULES: CapabilityModule[] = modulesJson.modules

const PUBLIC_NAMES = new Set(MODULES.filter((m) => m.public !== false).map((m) => m.name))
const ALL_NAMES = new Set(MODULES.map((m) => m.name))
const FEATURE_BY_NAME = new Map(
  MODULES.filter((m) => m.feature !== undefined).map((m) => [m.name, m.feature!]),
)
// Table order of first appearance, so feature lists render deterministically.
const FEATURES = [...new Set(MODULES.map((m) => m.feature).filter((f) => f !== undefined))]

/** Names of the public builtin modules (importable as `mikro/<name>`). */
export function builtinModules(): Set<string> {
  return new Set(PUBLIC_NAMES)
}

/** Whether `name` is a table module, internal ones included. The on-device
 * loader resolves internal builtins too, so the tracer must accept them. */
export function isTableModule(name: string): boolean {
  return ALL_NAMES.has(name)
}

// Export subpaths of the mikro package that carry types and no runtime module.
const TYPES_ONLY_NAMES = new Set(['console', 'format', 'sim'])

/** Whether `mikro/<name>` exists for its types only, so a value import of it
 * can never load on the device. */
export function isTypesOnlyModule(name: string): boolean {
  return TYPES_ONLY_NAMES.has(name)
}

/** The firmware feature gating `name` (a builtin module name without the
 * `mikro/` prefix), or undefined when the module is always available. */
export function moduleFeature(name: string): string | undefined {
  return FEATURE_BY_NAME.get(name)
}

/** Every firmware feature the table declares, unique, in table order. */
export function allFeatures(): string[] {
  return [...FEATURES]
}

/** The firmware features required by `moduleNames` (builtin module names
 * without the `mikro/` prefix), unique, in {@link allFeatures} order. */
export function requiredFeatures(moduleNames: Iterable<string>): string[] {
  const needed = new Set<string>()
  for (const name of moduleNames) {
    const feature = FEATURE_BY_NAME.get(name)
    if (feature !== undefined) needed.add(feature)
  }
  return FEATURES.filter((f) => needed.has(f))
}
