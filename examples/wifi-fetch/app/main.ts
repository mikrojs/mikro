import {env} from 'mikrojs/env'
import {request} from 'mikrojs/http/request'
import {memoryUsage} from 'mikrojs/sys'
import {wifi} from 'mikrojs/wifi'

const ssid = env.require('WIFI_SSID')
const passphrase = env.require('WIFI_PASSPHRASE')

// Connect to WiFi
console.log(`Connecting to ${ssid}...`)
const connectResult = await wifi.connect(ssid, passphrase)
if (!connectResult.ok) {
  console.error('WiFi connect failed: %s', connectResult.error.name)
} else {
  console.log('Connected! IP: %s', connectResult.value.ip)

  // Request JSON from an API
  const result = await request('https://jsonplaceholder.typicode.com/posts/1')
  if (result.ok) {
    if (!result.value.ok) {
      console.error(`HTTP error: ${result.value.status}`)
    } else {
      const data = await result.value.json()
      console.log('Fetched post: %o', data)
    }
  } else {
    console.error('Request failed: %s', result.error.name)
  }
}

const mem = memoryUsage()
console.log('free heap: %dKB', (mem.heapTotal - mem.heapUsed) / 1000)
