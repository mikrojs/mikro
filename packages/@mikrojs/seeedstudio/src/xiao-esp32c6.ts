// https://wiki.seeedstudio.com/xiao_esp32c6_getting_started/#pin-map
export const pinMap = {
  D0: {pin: 0, features: ['GPIO', 'ADC']},
  D1: {pin: 1, features: ['GPIO', 'ADC']},
  D2: {pin: 2, features: ['GPIO', 'ADC']},
  D3: {pin: 21, features: ['GPIO']},
  D4: {pin: 22, features: ['GPIO', 'SDA']},
  D5: {pin: 23, features: ['GPIO', 'SCL']},
  D6: {pin: 16, features: ['GPIO', 'TX']},
  D7: {pin: 17, features: ['GPIO', 'RX']},
  D8: {pin: 19, features: ['GPIO', 'SCK']},
  D9: {pin: 20, features: ['GPIO', 'MISO']},
  D10: {pin: 28, features: ['GPIO', 'MOSI']},
  MTDO: {pin: 7, features: ['JTAG']},
  MTDI: {pin: 5, features: ['JTAG', 'ADC']},
  MTCK: {pin: 6, features: ['JTAG', 'ADC']},
  MTMS: {pin: 4, features: ['JTAG', 'ADC']},
  PWR: {pin: 3, features: ['POWER']},
  LED: {pin: 15, features: ['LED']},
} as const

export const pins = Object.fromEntries(
  Object.entries(pinMap).map(([name, def]) => [name, def.pin]),
) as {[K in keyof typeof pinMap]: (typeof pinMap)[K]['pin']}
