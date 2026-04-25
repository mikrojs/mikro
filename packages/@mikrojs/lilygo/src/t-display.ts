import {createDisplay} from '@mikrojs/driver-st7789'

export {Color, hsvToRgb565, rgb565} from '@mikrojs/driver-st7789'

export const pinMap = {
  TFT_MOSI: {pin: 19, features: ['GPIO', 'SPI', 'MOSI']},
  TFT_SCLK: {pin: 18, features: ['SPI', 'SCK']},
  TFT_CS: {pin: 5, features: ['SPI', 'CS']},
  TFT_DC: {pin: 16, features: ['GPIO']},
  TFT_RST: {pin: 23, features: ['GPIO']},
  TFT_BL: {pin: 4, features: ['GPIO']},
  BTN1: {pin: 0, features: ['GPIO']},
  BTN2: {pin: 35, features: ['GPIO']},
  BAT_ADC: {pin: 34, features: ['GPIO', 'ADC']},
} as const

export const pins = Object.fromEntries(Object.entries(pinMap).map(([k, v]) => [k, v.pin])) as {
  [K in keyof typeof pinMap]: (typeof pinMap)[K]['pin']
}

const result = await createDisplay({
  spiHost: 1,
  width: 240,
  height: 135,
  offsetX: 53,
  offsetY: 40,
  pins: {mosi: 19, sclk: 18, cs: 5, dc: 16, rst: 23, bl: 4},
})

if (!result.ok) {
  throw new Error(`Failed to initialize T-Display: ${result.error.message}`)
}

export const display = result.value
