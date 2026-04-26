import * as fs from 'node:fs/promises'
import * as path from 'node:path'

type Chip =
  | 'auto'
  | 'esp8266'
  | 'esp32'
  | 'esp32s2'
  | 'esp32s3beta2'
  | 'esp32s3'
  | 'esp32c3'
  | 'esp32c6beta'
  | 'esp32h2beta1'
  | 'esp32h2beta2'
  | 'esp32c2'
  | 'esp32c6'
  | 'esp32h2'

type FlashMode = 'keep' | 'qio' | 'qout' | 'dio' | 'dout'

type FlashSize =
  | 'detect'
  | 'keep'
  | '256KB'
  | '512KB'
  | '1MB'
  | '2MB'
  | '2MB-c1'
  | '4MB'
  | '4MB-c1'
  | '8MB'
  | '16MB'
  | '32MB'
  | '64MB'
  | '128MB'

type FlashFreq =
  | 'keep'
  | '80m'
  | '60m'
  | '48m'
  | '40m'
  | '30m'
  | '26m'
  | '24m'
  | '20m'
  | '16m'
  | '15m'
  | '12m'

type CommonOptions = {
  chip?: Chip
  port: string
  baudRate: number
  before?: 'default_reset' | 'usb_reset' | 'no_reset' | 'no_reset_no_sync'
  after?: 'hard_reset' | 'soft_reset' | 'no_reset' | 'no_reset_stub'
  noStub?: boolean
  trace?: boolean
  connectAttempts?: number
}

export interface FlashEntry {
  address: number
  filename: string
}

export interface WriteFlashMultiOptions extends CommonOptions {
  files: FlashEntry[]
  compress?: boolean
  erase?: boolean
  freq?: FlashFreq
  flashMode?: FlashMode
  flashSize?: FlashSize
  noProgress?: boolean
  verify?: boolean
}

export interface FlasherArgs {
  chip: Chip
  before: CommonOptions['before']
  after: CommonOptions['after']
  flashMode: FlashMode
  flashSize: FlashSize
  flashFreq: FlashFreq
  files: FlashEntry[]
}

export async function readFlasherArgs(buildDir: string): Promise<FlasherArgs> {
  const raw = await fs.readFile(path.join(buildDir, 'flasher_args.json'), 'utf-8')
  const json = JSON.parse(raw)

  const files: FlashEntry[] = Object.entries(json.flash_files as Record<string, string>).map(
    ([addr, file]) => ({
      address: Number(addr),
      filename: path.resolve(buildDir, file),
    }),
  )

  return {
    chip: json.extra_esptool_args.chip ?? 'auto',
    before: json.extra_esptool_args.before,
    after: json.extra_esptool_args.after,
    flashMode: json.flash_settings.flash_mode,
    flashSize: json.flash_settings.flash_size,
    flashFreq: json.flash_settings.flash_freq,
    files,
  }
}

export function getWriteFlashMultiArgs(options: WriteFlashMultiOptions) {
  return [
    ['--chip', options.chip ?? 'auto'],
    ['--port', options.port],
    ['--baud', String(options.baudRate)],

    typeof options.before === 'string' ? ['--before', options.before] : [],
    typeof options.after === 'string' ? ['--after', options.after] : [],
    ['write-flash'],
    options.noStub === true ? ['--no-stub'] : [],
    options.trace ? ['--trace'] : [],
    options.compress ? ['--compress'] : [],
    options.noProgress === true ? ['--no-progress'] : [],
    typeof options.connectAttempts === 'number'
      ? ['--connect-attempts', String(options.connectAttempts)]
      : [],
    typeof options.flashMode === 'string' ? ['--flash-mode', String(options.flashMode)] : [],
    typeof options.flashSize === 'string' ? ['--flash-size', String(options.flashSize)] : [],
    options.verify ? ['--verify'] : [],
    ...options.files.flatMap((f) => [[String(f.address)], [f.filename]]),
  ]
    .filter((arg) => arg.length > 0)
    .flatMap((arg) => arg)
}
