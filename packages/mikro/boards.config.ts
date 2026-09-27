// The generic boards: the firmware without anything board-specific, one board
// per chip, each with a no-ble and a no-ble+no-wifi image besides the full one.
// The release builds them with `mikro fw prepack` (one image per CI job) into
// dist-fw/, and the CLI flashes them when a project has no board of its own.
// They ship with mikro, so apps never list them.
import {type BoardConfig, type Chip, defineBoards} from 'mikro'

function generic(chip: Chip, board: Partial<BoardConfig> = {}): BoardConfig {
  // Devices and registries know these boards by the short name.
  return {
    chip,
    name: `${chip}-generic`,
    description: `Generic ${chip} board`,
    images: [{ble: false}, {ble: false, wifi: false}],
    ...board,
  }
}

export default defineBoards({
  boards: {
    './esp32-generic': generic('esp32'),
    './esp32c3-generic': generic('esp32c3'),
    './esp32c5-generic': generic('esp32c5'),
    './esp32c6-generic': generic('esp32c6'),
    './esp32s3-generic': generic('esp32s3', {sdkconfig: 'generic/esp32s3.defaults'}),
  },
})
