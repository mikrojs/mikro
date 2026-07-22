/* eslint-disable no-console -- server process; console is its log output */
import {randomBytes} from 'node:crypto'
import * as os from 'node:os'
import * as pathlib from 'node:path'

import {createRegistry} from '@mikrojs/registry'
import {fileStorage, serve} from '@mikrojs/registry/node'

// Builds and device records land next to this file, wherever it is run from.
const dataDir = pathlib.join(import.meta.dirname, 'data')

const port = parseInt(process.env.PORT ?? '4873', 10)
const password = process.env.REGISTRY_PASSWORD
if (password === undefined || password === '') {
  // A suggested password rather than a placeholder: this one is submitted over
  // the network on the approve page, so a memorable default is a guessable one.
  console.error('REGISTRY_PASSWORD is not set. Start the server with one, for example:')
  console.error('')
  console.error(`  REGISTRY_PASSWORD=${randomBytes(18).toString('base64url')} npm run registry`)
  console.error('')
  console.error('You enter it in the browser when `mikro ota setup` asks this registry to')
  console.error('approve access; the CLI then receives its own token.')
  process.exit(1)
}

/** First non-internal IPv4 address, so devices on the LAN can reach us. */
function localAddress(): string {
  return (
    Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal)?.address ?? 'localhost'
  )
}

// Offers link back to this origin, and it is what .mikro/registry.json should
// point at. Devices on your LAN must be able to reach it; set BASE_URL when
// the server sits behind a proxy or picks the wrong interface.
const baseUrl = process.env.BASE_URL ?? `http://${localAddress()}:${port}`

const registry = createRegistry({storage: fileStorage(dataDir), token: password, baseUrl})

const home = os.homedir()
const displayDataDir = dataDir.startsWith(home + pathlib.sep)
  ? `~${dataDir.slice(home.length)}`
  : dataDir

serve(registry, {port})
console.log(`registry listening on ${baseUrl} (data in ${displayDataDir})`)
console.log('')
console.log('Point a project at it with:')
console.log('')
console.log(`  pn mikro ota setup --registry ${baseUrl}`)
