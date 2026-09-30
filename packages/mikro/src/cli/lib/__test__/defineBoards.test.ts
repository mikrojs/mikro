import {defineBoards} from 'mikro'
import {expect, it} from 'vitest'

it('takes boards that share a base declared as const', () => {
  const devkit = {chip: 'esp32s3', nativeModules: ['@acme/drivers/st7789']} as const
  const config = defineBoards({
    boards: {
      './devkit-n8': devkit,
      './devkit-n16r8': {...devkit, sdkconfig: 'octal-psram.defaults'},
    },
  })
  expect(Object.keys(config.boards)).toEqual(['./devkit-n8', './devkit-n16r8'])
})

it('takes a board on the generic firmware by its name, and nothing it gets from it', () => {
  defineBoards({boards: {'./t-display': {firmware: 'esp32-generic', description: 'T-Display'}}})
  defineBoards({
    boards: {
      // @ts-expect-error a generic board that doesn't exist
      './a': {firmware: 'esp32c9-generic'},
      // @ts-expect-error the chip comes from the generic board
      './b': {firmware: 'esp32-generic', chip: 'esp32'},
      // @ts-expect-error a board builds its own image or runs a generic one
      './c': {chip: 'esp32', sdkconfig: 'x.defaults', firmware: 'esp32-generic'},
    },
  })
})
