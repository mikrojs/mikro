import {sleep} from 'mikrojs/sleep'
import {wifi} from 'mikrojs/wifi'

// Country must be set before using WiFi
wifi.country = 'NO'

// Start the access point
wifi.ap
  .start({
    ssid: 'MikroJS-AP',
    passphrase: 'hello1234',
    channel: 6,
    maxConnections: 4,
  })
  .orPanic('Failed to start access point')

console.log('Access point started')
console.log('SSID: MikroJS-AP')
console.log('IP: %s', wifi.ap.ip)

// Log when stations connect/disconnect
wifi.ap.on('station-connect', (info) => {
  console.log('Station connected: %s', info.mac)
})

wifi.ap.on('station-disconnect', (info) => {
  console.log('Station disconnected: %s', info.mac)
})

// Periodically print connected stations
while (true) {
  await sleep(10000)
  const stations = wifi.ap.stations
  if (stations.length > 0) {
    console.log(`Connected stations (${stations.length}):`)
    for (const sta of stations) {
      console.log(`  ${sta.mac} (RSSI: ${sta.rssi})`)
    }
  }
}
