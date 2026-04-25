import {createDisplay} from '@mikrojs/driver-sh8601'

export const pinMap = {
  LCD_CLK: {pin: 13, features: ['SPI', 'CLK']},
  LCD_D0: {pin: 15, features: ['SPI', 'DATA']},
  LCD_D1: {pin: 16, features: ['SPI', 'DATA']},
  LCD_D2: {pin: 17, features: ['SPI', 'DATA']},
  LCD_D3: {pin: 18, features: ['SPI', 'DATA']},
  LCD_CS: {pin: 14, features: ['SPI', 'CS']},
  LCD_RST: {pin: 21, features: ['GPIO']},
  LCD_BL: {pin: 47, features: ['GPIO', 'PWM']},
  TOUCH_SDA: {pin: 11, features: ['I2C', 'SDA']},
  TOUCH_SCL: {pin: 12, features: ['I2C', 'SCL']},
  TOUCH_RST: {pin: 10, features: ['GPIO']},
  TOUCH_INT: {pin: 9, features: ['GPIO']},
  ENC_A: {pin: 8, features: ['GPIO']},
  ENC_B: {pin: 7, features: ['GPIO']},
} as const

const result = createDisplay({
  width: 360,
  height: 360,
  spiHost: 1,
  pins: {clk: 13, d0: 15, d1: 16, d2: 17, d3: 18, cs: 14, rst: 21, bl: 47},
})

if (!result.ok) {
  throw new Error(`Failed to initialize display: ${result.error.message}`)
}

export const display = result.value
