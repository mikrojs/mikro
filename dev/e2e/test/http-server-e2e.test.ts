/* eslint-disable no-console */
import {env} from 'mikro/env'
import {memoryUsage} from 'mikro/sys'
import {afterAll, assert, beforeAll, describe, test} from 'mikro/test'

const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')
const hasWifi = WIFI_SSID && WIFI_PASSPHRASE
const isSim = env.get('MIKRO_ENV') === 'simulator'

// The request/wifi module graph plus TLS working room needs ~48KB of
// free JS heap (estimate; the graph alone retains ~30KB). Chips whose
// per-file runtime has less than that skip this file (e.g. esp32c3).
const m = memoryUsage()
const fitsHttp = m.heapTotal - m.heapUsed > 48 * 1024

const PORT = 8088

let request: typeof import('mikro/http/request').request

describe.runIf(hasWifi && !isSim && fitsHttp)('http server e2e', () => {
  let base = ''
  let server: import('mikro/http/server').Server | undefined

  beforeAll(async () => {
    ;({request} = await import('mikro/http/request'))
    const {wifi} = await import('mikro/wifi')
    const connected = await wifi.connect(WIFI_SSID!, WIFI_PASSPHRASE!)
    assert.equal(connected.ok, true, 'wifi connect')
    if (!connected.ok) return
    base = `http://${connected.value.ip}:${PORT}`
    console.log(`serving on ${base}`)

    const {createServer} = await import('mikro/http/server')
    server = createServer(async (req) => {
      const path = req.url.split('?')[0]
      if (req.method === 'GET' && path === '/hello') {
        return {status: 200, body: 'hello from device'}
      }
      if (req.method === 'POST' && path === '/echo') {
        const body = await req.text()
        return {status: 200, body: body.ok ? body.value : ''}
      }
      return {status: 404, body: 'not found'}
    })
    const listen = server.listen({port: PORT})
    assert.equal(listen.ok, true, `listen: ${listen.ok ? '' : listen.error.name}`)
  })

  afterAll(() => {
    server?.close()
  })

  test('GET routes to a handler and returns its body', async () => {
    const res = await request(`${base}/hello`, {timeoutMs: 5000})
    assert.ok(res, `fetch failed: ${res.ok ? '' : res.error.name}`)
    assert.equal(res.value.status, 200)
    const body = await res.value.text()
    assert.ok(body)
    assert.equal(body.value, 'hello from device')
    await res.value.close()
  })

  test('an unmatched route returns 404', async () => {
    const res = await request(`${base}/nope`, {timeoutMs: 5000})
    assert.ok(res, `fetch failed: ${res.ok ? '' : res.error.name}`)
    assert.equal(res.value.status, 404)
    await res.value.close()
  })

  test('a POST body is read in the handler and echoed back', async () => {
    const res = await request(`${base}/echo`, {method: 'POST', body: 'ping', timeoutMs: 5000})
    assert.ok(res, `fetch failed: ${res.ok ? '' : res.error.name}`)
    assert.equal(res.value.status, 200)
    const body = await res.value.text()
    assert.ok(body)
    assert.equal(body.value, 'ping')
    await res.value.close()
  })

  test('listening again while running returns AlreadyListening', () => {
    assert.truthy(server, 'server should be running')
    if (!server) return
    const again = server.listen({port: PORT})
    assert.equal(again.ok, false, 'second listen should fail')
    if (!again.ok) assert.equal(again.error.name, 'AlreadyListening')
  })
})
