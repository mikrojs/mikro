import {describe, expect, it} from 'vitest'

import {selectReleaseAsset, selectWorkflowArtifact} from '../firmware.js'

function assets(...names: string[]) {
  return names.map((name) => ({name, url: `https://example.com/${name}`}))
}

function artifacts(...names: string[]) {
  return names.map((name, id) => ({id, name, expired: false}))
}

describe('selectReleaseAsset', () => {
  const release = assets(
    'mikro-fw-esp32c6-generic.tar.gz',
    'mikrojs-firmware-esp32c6-generic.tar.gz',
    'mikrojs-firmware-esp32c6.tar.gz',
    'mikro-fw-esp32s3-generic.tar.gz',
    'mikro-fw-acme-devboard-esp32s3.tar.gz',
  )

  it('takes the mikro-fw archive of the board and chip', () => {
    const pick = (board: string | undefined, chip: string) =>
      selectReleaseAsset(release, chip, board, 'org/repo').name
    expect(pick('esp32c6-generic', 'esp32c6')).toBe('mikro-fw-esp32c6-generic.tar.gz')
    expect(pick('@acme/devboard', 'esp32s3')).toBe('mikro-fw-acme-devboard-esp32s3.tar.gz')
  })

  it('finds the names of older releases', () => {
    const old = assets('mikrojs-firmware-esp32c6.tar.gz', 'mikrojs-firmware-esp32s3.tar.gz')
    expect(selectReleaseAsset(old, 'esp32c6', 'esp32c6-generic', 'org/repo').name).toBe(
      'mikrojs-firmware-esp32c6.tar.gz',
    )
    const board = assets('mikrojs-firmware-acme-devboard.tar.gz', 'mikrojs-firmware-esp32s3.tar.gz')
    expect(selectReleaseAsset(board, 'esp32s3', '@acme/devboard', 'org/repo').name).toBe(
      'mikrojs-firmware-acme-devboard.tar.gz',
    )
  })

  it('does not take a chip word inside the name for the chip', () => {
    const other = assets('mikro-fw-acme-esp32-board-esp32s3.tar.gz', 'mikro-fw-x-esp32s3.tar.gz')
    expect(() => selectReleaseAsset(other, 'esp32', 'esp32-generic', 'org/repo')).toThrow(
      /Multiple firmware assets/,
    )
  })

  it('picks custom firmware by the chip when no board names it', () => {
    const custom = assets(
      'mikro-fw-my-firmware-esp32c6.tar.gz',
      'mikro-fw-my-firmware-esp32s3.tar.gz',
    )
    expect(selectReleaseAsset(custom, 'esp32s3', 'esp32s3-generic', 'org/repo').name).toBe(
      'mikro-fw-my-firmware-esp32s3.tar.gz',
    )
  })
})

describe('selectWorkflowArtifact', () => {
  it('takes the mikro-fw artifact, or the older names', () => {
    const run = artifacts('mikro-fw-esp32c6-generic', 'mikro-fw-acme-devboard-esp32s3')
    expect(selectWorkflowArtifact(run, 'esp32s3', '@acme/devboard', 'org/repo').name).toBe(
      'mikro-fw-acme-devboard-esp32s3',
    )
    const old = artifacts('mikrojs-firmware-esp32c6-generic', 'firmware-esp32s3-generic')
    expect(selectWorkflowArtifact(old, 'esp32c6', 'esp32c6-generic', 'org/repo').name).toBe(
      'mikrojs-firmware-esp32c6-generic',
    )
    expect(selectWorkflowArtifact(old, 'esp32s3', 'esp32s3-generic', 'org/repo').name).toBe(
      'firmware-esp32s3-generic',
    )
  })
})
