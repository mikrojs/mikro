import {existsSync, renameSync} from 'node:fs'
import {join} from 'node:path'

import {paths} from './envPaths.js'

/**
 * Aliases used to live in this workstation-local file, keyed by USB serial.
 * Names are now owned by the device itself, and the two cannot be mapped onto
 * each other without connecting to every board, so the old file is not
 * migrated. Say so once instead of letting a user's names silently vanish on
 * upgrade, then rename the file so the notice does not repeat.
 *
 * Called at CLI startup rather than from a command: the rename disarms it, so
 * it fires exactly once regardless, and hanging it off any single command means
 * whoever does not run that command never hears about it.
 */
const LEGACY_FILE = 'device-aliases.json'

export function noticeLegacyAliases(): void {
  const legacy = join(paths.config, LEGACY_FILE)
  if (!existsSync(legacy)) return

  // Never clobber an earlier backup: an older CLI on the same machine can
  // recreate the legacy file, and the notice promises the previous one is kept.
  let retired = `${legacy}.retired`
  for (let i = 2; existsSync(retired); i++) retired = `${legacy}.retired.${i}`
  try {
    renameSync(legacy, retired)
  } catch {
    // Leaving the file in place only means the notice shows again next time.
    return
  }

  // stderr, not stdout: this fires on whatever command the user happens to run
  // first, and several of those have output something is parsing.
  /* eslint-disable no-console */
  console.error('')
  console.error('Device aliases have been replaced by names stored on the device itself.')
  console.error(`Your old aliases are not carried over. They are kept at ${retired}.`)
  console.error('Set a name with `mikro name set <name>` while connected to the device.')
  /* eslint-enable no-console */
}
