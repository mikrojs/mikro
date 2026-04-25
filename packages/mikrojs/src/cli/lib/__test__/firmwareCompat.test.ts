import {describe, expect, it} from 'vitest'

import {checkFirmwareCompat} from '../firmwareCompat.js'

describe('checkFirmwareCompat', () => {
  it('returns compatible for a version that satisfies the range', () => {
    const result = checkFirmwareCompat('0.0.0')
    expect(result.compatible).to.be.true
    expect(result.deviceVersion).to.equal('0.0.0')
    expect(result.requiredRange).to.be.a('string')
  })

  it('returns incompatible when device reports no version', () => {
    const result = checkFirmwareCompat(null)
    expect(result.compatible).to.be.false
    expect(result.deviceVersion).to.be.null
  })

  it('returns compatible for a higher version', () => {
    const result = checkFirmwareCompat('99.0.0')
    expect(result.compatible).to.be.true
  })
})
