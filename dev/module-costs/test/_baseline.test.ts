import {describe, test} from 'mikro/test'

// The harness pedestal: what a file that imports nothing retains. Every
// other file's cost is its heapDelta minus this one's.
describe('_baseline', () => {
  test('nothing', () => {})
})
