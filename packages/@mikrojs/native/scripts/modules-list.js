#!/usr/bin/env node
/**
 * Print the builtin module lists derived from runtime/modules.json for CMake.
 *
 * Usage: node modules-list.js [--host] [--ble=on|off] [--wifi=on|off]
 *
 * - `--host`: the host/sim build: every module, no compile gating
 * - `--ble`, `--wifi`: device builds only; a module whose `when` names the
 *   gate is included iff it is `on`
 *
 * Prints one JSON object on stdout, each value a semicolon-separated CMake list:
 * - `bytecode`: bytecode module names (mikrojs_generate_bytecode MODULES)
 * - `native`: native module ids (mikrojs_force_include_modules)
 * - `features`: firmware features present in the build (for MIK_FW_FEATURES)
 *
 * Fields of a runtime/modules.json entry:
 * - `name`: the module name; the import specifier is `mikro/<name>`
 * - `bytecode: false`: served from C, no bytecode bundle
 * - `native`: id of the self-registering native module that is force-included
 *   on device (MIK_REGISTER_MODULE / MIK__REGISTER_PUBLIC_MODULE)
 * - `feature`: the firmware feature the module needs (types, MSG_READY)
 * - `when`: the compile gate (ble = CONFIG_BT_ENABLED, wifi =
 *   CONFIG_MIKROJS_WIFI); the module is left out when the gate is off
 * - `public: false`: internal, no `mikro/*` export subpath
 *
 * Order matters: it is the order of the generated builtin table. `ble` stays
 * last among the bytecode modules, where CONFIG_BT_ENABLED used to append it.
 */
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'

const modulesJsonPath = fileURLToPath(new URL('../runtime/modules.json', import.meta.url))
const {modules} = JSON.parse(readFileSync(modulesJsonPath, 'utf8'))

const host = process.argv.includes('--host')
const gates = ['ble', 'wifi']
const flags = Object.fromEntries(
  gates.map((g) => [g, process.argv.find((a) => a.startsWith(`--${g}=`))]),
)

if (!host && gates.some((g) => !flags[g])) {
  process.stderr.write('modules-list.js: device builds must pass --ble=on|off and --wifi=on|off\n')
  process.exit(1)
}

const off = new Set(host ? [] : gates.filter((g) => flags[g] !== `--${g}=on`))
const included = modules.filter((m) => !m.when || !off.has(m.when))
const bytecode = included.filter((m) => m.bytecode !== false).map((m) => m.name)
const native = included.filter((m) => m.native).map((m) => m.native)
// A module can need a feature without being compiled under its gate
// (http/server needs wifi and always compiles), so a feature whose gate is
// off is dropped here. This relies on each gated feature having the same
// name as its gate.
const features = [...new Set(included.filter((m) => m.feature).map((m) => m.feature))].filter(
  (f) => !off.has(f),
)

process.stdout.write(
  JSON.stringify({
    bytecode: bytecode.join(';'),
    native: native.join(';'),
    features: features.join(';'),
  }),
)
