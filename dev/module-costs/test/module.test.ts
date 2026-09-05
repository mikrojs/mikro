import {describe, test} from 'mikro/test'

describe('mikro/module', () => {
  test('import', async () => {
    await import('mikro/module')
  })
})
