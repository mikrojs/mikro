import {env} from 'mikro/env'
import {request} from 'mikro/http/request'
import {memoryUsage} from 'mikro/sys'
import {wifi} from 'mikro/wifi'

const TARGET_URL = env.get('TARGET_URL') ?? 'https://jsonplaceholder.typicode.com/posts/1'
const STEP_KB = Number(env.get('STEP_KB') ?? '8')
const MAX_STEPS = Number(env.get('MAX_STEPS') ?? '20')

// Roughly 80 bytes per retained object (header + 4 props). Used to convert
// the per-step KB target into an object count.
const PER_OBJECT_BYTES = 80

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')

console.log('Connecting to %s ...', ssid)
const connect = await wifi.connect(ssid, passphrase)
if (!connect.ok) {
  console.error('WiFi connect failed: %s', connect.error.name)
} else {
  console.log('Connected. IP: %s', connect.value.ip)
  await sweep()
}

async function sweep() {
  // Retained ballast. Pushing onto a global array prevents GC.
  const ballast: object[] = []
  const objectsPerStep = Math.floor((STEP_KB * 1024) / PER_OBJECT_BYTES)

  for (let step = 0; step <= MAX_STEPS; step++) {
    const pressureKb = step * STEP_KB
    logMem('before', step, pressureKb)

    const t0 = Date.now()
    const result = await request(TARGET_URL)
    const elapsed = Date.now() - t0

    if (!result.ok) {
      console.error('  FAIL after %dms: %s', elapsed, result.error.name)
      logMem('after', step, pressureKb)
      console.error('  threshold reached at pressure=%dKB. Stopping.', pressureKb)
      return
    }
    if (!result.value.ok) {
      console.warn('  HTTP %d after %dms', result.value.status, elapsed)
    } else {
      const body = await result.value.text()
      console.log('  OK %d bytes in %dms', body.length, elapsed)
    }
    // Post-fetch read shows the low-water mark left by mbedTLS handshake +
    // socket buffers. Compare to the pre-fetch reading: the handshake's own
    // internal-SRAM allocations are what actually trip the threshold.
    logMem('after', step, pressureKb)

    for (let i = 0; i < objectsPerStep; i++) {
      ballast.push({a: step, b: i, c: i + 1, d: 'x'})
    }
  }

  console.log(
    '\nNo failure within %d steps (max pressure %dKB). Increase STEP_KB or MAX_STEPS.',
    MAX_STEPS,
    MAX_STEPS * STEP_KB,
  )
  console.log('ballast retained: %d objects', ballast.length)
}

function logMem(phase: 'before' | 'after', step: number, pressureKb: number) {
  const m = memoryUsage()
  const header =
    phase === 'before' ? `\n=== step ${step}  pressure=${pressureKb}KB  [pre]` : '  [post]'
  console.log(
    '%s  internalFree=%d  internalLargest=%d  heapUsed=%d',
    header,
    m.internalFree,
    m.internalLargestFree,
    m.heapUsed,
  )
}
