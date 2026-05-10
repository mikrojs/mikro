import {map} from 'mikrojs/observable/operators'
import {sleep} from 'mikrojs/sleep'
import {wifi} from 'mikrojs/wifi'

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
wifi.ap.onStationConnect.pipe(map((v) => v.mac)).subscribe((mac) => {
  console.log('Station connected: %s', mac)
})

wifi.ap.onStationDisconnect.subscribe((info) => {
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
