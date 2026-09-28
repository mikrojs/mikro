import {command, constant, message, object, optional} from '@optique/core'
import {flag, option} from '@optique/core/primitives'
import {string} from '@optique/core/valueparser'

import {port} from '../lib/portValueParser.js'

export const args = command(
  'flash',
  object({
    action: constant('flash'),
    buildDir: optional(
      option('--build-dir', string({metavar: 'DIR'}), {
        description: message`Path to a local ESP-IDF build directory.`,
      }),
    ),
    from: optional(
      option('--from', string({metavar: 'URL'}), {
        description: message`The URL of a firmware archive (a .tar.gz, as mikro fw pack writes it), flashed as it is.`,
      }),
    ),
    board: optional(
      option('--board', string({metavar: 'BOARD'}), {
        description: message`Board name, for example @acme/devboard or esp32c6-generic. Discovered from package.json if omitted.`,
      }),
    ),
    features: optional(
      option('--features', string({metavar: 'FEATURES'}), {
        description: message`Flash the leanest of the board's images with these features, comma-separated (wifi, or wifi,ble), min for the leanest image, or full for the full image. Without it, a reflash keeps the image the device runs.`,
      }),
    ),
    chip: optional(
      option('--chip', string({metavar: 'CHIP'}), {
        description: message`The device's chip (e.g. esp32c6). Detected from the connected device if omitted.`,
      }),
    ),
    port: optional(
      option('-p', '--port', port(), {
        description: message`Serial port of device to flash to. Auto-detected if omitted.`,
      }),
    ),
    baud: optional(
      option('--baud', string({metavar: 'BAUD'}), {
        description: message`Baud rate for flashing (default: 460800)`,
      }),
    ),
    yes: optional(
      flag('-y', '--yes', {
        description: message`Skip confirmation prompt`,
      }),
    ),
    force: optional(
      flag('--force', {
        description: message`Flash even if the device reports custom firmware or the new partition table shrinks the app filesystem`,
      }),
    ),
  }),
)
