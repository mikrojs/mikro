/* eslint-disable no-console */
import {env} from 'mikro/env'
import {assert, beforeAll, describe, test} from 'mikro/test'
import {bind} from 'mikro/udp'
import {wifi} from 'mikro/wifi'

const WIFI_SSID = env.get('WIFI_SSID')
const WIFI_PASSPHRASE = env.get('WIFI_PASSPHRASE')
const hasWifi = WIFI_SSID && WIFI_PASSPHRASE

/* ── Lifecycle tests — work on bare device, no network needed ───── */

describe('udp lifecycle', () => {
  test('bind to ephemeral port assigns a real port', async () => {
    const r = await bind({port: 0, family: 'ipv4'})
    assert.ok(r)
    if (!r.ok) return
    const sock = r.value
    assert.truthy(sock.port > 0, `port should be > 0, got ${sock.port}`)
    assert.truthy(sock.port < 65536, `port should be < 65536, got ${sock.port}`)
    assert.equal(sock.family, 'ipv4')
    sock.close()
  })

  test('close is idempotent', async () => {
    const r = await bind({port: 0, family: 'ipv4'})
    assert.ok(r)
    if (!r.ok) return
    r.value.close()
    r.value.close()
    /* no throw, no error */
  })

  test('send after close returns Closed', async () => {
    const r = await bind({port: 0, family: 'ipv4'})
    assert.ok(r)
    if (!r.ok) return
    const sock = r.value
    sock.close()
    const sr = await sock.send('x', {address: '127.0.0.1', port: 1234, family: 'ipv4'})
    assert.equal(sr.ok, false)
    if (!sr.ok) assert.equal(sr.error.name, 'Closed')
  })

  test('dual-stack is the default family', async () => {
    const r = await bind({port: 0})
    assert.ok(r)
    if (!r.ok) return
    /* dual-stack v6 socket is exposed as 'dual' */
    assert.equal(r.value.family, 'dual')
    r.value.close()
  })
})

/* ── Roundtrip — needs an interface up; gated on WiFi env vars ──── */

describe.runIf(hasWifi)('udp over wifi', () => {
  let localIp: string

  beforeAll(async () => {
    const connected = await wifi.connect(WIFI_SSID!, WIFI_PASSPHRASE!)
    assert.equal(connected.ok, true, 'wifi connect')
    if (connected.ok) {
      localIp = connected.value.ip
      console.log(`connected: ${localIp}`)
    }
  })

  test('joinMulticastGroup and leaveMulticastGroup return ok', async () => {
    const r = await bind({port: 0, family: 'ipv4'})
    assert.ok(r)
    if (!r.ok) return
    const sock = r.value
    const j = sock.joinMulticastGroup({address: '224.0.0.251'})
    assert.equal(j.ok, true, `join failed: ${!j.ok ? j.error.name : ''}`)
    const l = sock.leaveMulticastGroup({address: '224.0.0.251'})
    assert.equal(l.ok, true, `leave failed: ${!l.ok ? l.error.name : ''}`)
    sock.close()
  })

  test('two sockets exchange a payload via the local IP', async () => {
    const r1 = await bind({port: 0, family: 'ipv4'})
    assert.ok(r1)
    if (!r1.ok) return
    const sock1 = r1.value

    let received: {msg: string; from: string} | undefined
    const onMessageSub = sock1.onMessage.subscribe(({msg, from}) => {
      received = {msg: new TextDecoder().decode(msg), from: `${from.address}:${from.port}`}
    })

    const r2 = await bind({port: 0, family: 'ipv4'})
    assert.ok(r2)
    if (!r2.ok) return
    const sr = await r2.value.send('hello', {
      address: localIp,
      port: sock1.port,
      family: 'ipv4',
    })
    assert.equal(sr.ok, true, `send: ${!sr.ok ? sr.error.name : ''}`)

    /* Poll for delivery; UDP over WiFi loopback is fast but not synchronous. */
    for (let i = 0; i < 100 && !received; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
    }

    assert.truthy(received, 'did not receive within timeout')
    if (!received) return
    assert.equal(received.msg, 'hello')

    onMessageSub.unsubscribe()
    sock1.close()
    r2.value.close()
  })
})
