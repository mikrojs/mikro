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
