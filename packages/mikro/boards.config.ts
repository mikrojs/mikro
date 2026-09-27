// The generic boards: the firmware without anything board-specific, one board
// per chip, each with a no-ble and a no-ble+no-wifi image besides the full one.
// The release builds them with `mikro fw build` (one image per CI job) into
// dist-fw/, and the CLI flashes them when a project has no board of its own.
// They ship with mikro, so apps never list them. Devices and registries know
// them by the short name.
import {defineBoards} from 'mikro'

const LEAN_IMAGES = [{ble: false}, {ble: false, wifi: false}] as const

export default defineBoards({
  boards: {
    './esp32-generic': {
      chip: 'esp32',
      name: 'esp32-generic',
      description: 'Generic ESP32 board',
      images: LEAN_IMAGES,
    },
    './esp32c3-generic': {
      chip: 'esp32c3',
      name: 'esp32c3-generic',
      description: 'Generic ESP32-C3 board',
      images: LEAN_IMAGES,
    },
    './esp32c5-generic': {
      chip: 'esp32c5',
      name: 'esp32c5-generic',
      description: 'Generic ESP32-C5 board',
      images: LEAN_IMAGES,
    },
    './esp32c6-generic': {
      chip: 'esp32c6',
      name: 'esp32c6-generic',
      description: 'Generic ESP32-C6 board',
      images: LEAN_IMAGES,
    },
    './esp32s3-generic': {
      chip: 'esp32s3',
      name: 'esp32s3-generic',
      description: 'Generic ESP32-S3 board',
      sdkconfig: 'sdkconfig/esp32s3-generic.defaults',
      images: LEAN_IMAGES,
    },
  },
})
