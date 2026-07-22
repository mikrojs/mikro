import {firstValueFrom} from 'rxjs'

import {rememberDeviceForPort} from './deviceCache.js'
import {deviceGeneratedName, encodeDeviceName, NAME_KV} from './deviceName.js'
import {openSession} from './serial/openSession.js'

/**
 * The post-flash step: reconnect once the freshly flashed firmware has booted
 * and confirm it answers the handshake, which is the only thing that proves the
 * image actually runs (esptool only proves it was written).
 *
 * Flashing is also the one unambiguous provisioning moment — the board is
 * being made into a device, and NVS survives it — so an unnamed device is
 * seeded with a real name here. That keeps the id-derived name a one-time
 * seed: once stored it never changes, whereas deriving it for display would
 * make a device's name a function of the CLI version. Commands that merely
 * read or deploy never write identity, which is why this lives in flash and
 * not in the connect path.
 */
export interface PostFlashResult {
  chip: string | null
  firmware: string | null
  deviceId: string | null
  /** Undefined only when there was no device id to seed a name from. */
  name: string | undefined
  /** True when this run minted and stored the name. */
  seeded: boolean
  /** The device holds a name pair that could not be read, so no name was
   *  seeded. Only an explicit `mikro name set` can resolve it. */
  nameUnreadable: boolean
}

export async function runPostFlash(port: string): Promise<PostFlashResult> {
  // 'report' rather than 'enforce': a version mismatch is worth surfacing but
  // must not turn a successful flash into a failure.
  const handles = await openSession({port, compat: 'report'})
  try {
    const ready = await firstValueFrom(handles.session.awaitReady$())

    let name = ready.name
    let seeded = false
    let nameUnreadable = false
    // Only a device that has never been named gets a seed. A missing name at
    // rev > 0 means `mikro name unset` cleared it on purpose; re-seeding would
    // both resurrect it and, being a higher revision than the registry's, push
    // it back out as a rename the user never asked for.
    //
    // Unreadable stored bytes look identical to never-named (rev 0, no name)
    // but are not: the real revision is unknown, so seeding at rev 1 would
    // overwrite a name that is actually set and still lose to a registry
    // holding a higher revision. Leave it for an explicit `mikro name set`.
    if (ready.nameCorrupt === true) {
      nameUnreadable = true
    } else if (name === undefined && (ready.nameRev ?? 0) === 0) {
      const derived = deviceGeneratedName(undefined, ready.id)
      if (derived !== undefined) {
        await handles.session.kv.set(NAME_KV, encodeDeviceName({rev: 1, name: derived}), 'sys')
        name = derived
        seeded = true
      }
    }

    await rememberDeviceForPort(port, {
      chip: ready.chip ?? undefined,
      deviceId: ready.id ?? undefined,
      name: name ?? null,
    })

    return {
      chip: ready.chip,
      firmware: ready.version,
      deviceId: ready.id,
      name,
      seeded,
      nameUnreadable,
    }
  } finally {
    handles.close()
  }
}
