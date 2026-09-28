import {describe, expect, it} from 'vitest'

import {formatTargetDir, isValidPackageName, packageNameFor, toValidPackageName} from './names.js'

describe('formatTargetDir', () => {
  it.each([
    ['  my-app  ', 'my-app'],
    ['my-app///', 'my-app'],
    ['my<app>?', 'myapp'],
    ['@acme/devboard', '@acme/devboard'],
  ])('%s → %s', (input, expected) => {
    expect(formatTargetDir(input)).toBe(expected)
  })
})

describe('packageNameFor', () => {
  it.each([
    ['my-app', 'my-app'],
    ['acme/devboard', 'devboard'],
    ['My App', 'My App'],
    ['.', 'cwd'],
    ['../other', 'other'],
    // Unlike create-vite, which would name the package "devboard"
    ['@acme/devboard', '@acme/devboard'],
    // Kept, to be cleaned up rather than lose its scope
    ['@ACME/devboard', '@ACME/devboard'],
  ])('%s → %s', (targetDir, expected) => {
    expect(packageNameFor(targetDir, '/work/cwd')).toBe(expected)
  })
})

describe('toValidPackageName', () => {
  it.each([
    ['My App', 'my-app'],
    ['Café', 'cafe'],
    ['Ünïcödé_name', 'unicode-name'],
    ['_private', 'private'],
    ['a!!b', 'ab'],
    ['@Acme/Dev Board', '@acme/dev-board'],
  ])('%s → %s', (input, expected) => {
    expect(toValidPackageName(input)).toBe(expected)
    expect(isValidPackageName(expected)).toBe(true)
  })

  it.each(['项目', '!!!', '@!!!/devboard', '@acme/!!!'])('gives up on %s', (input) => {
    expect(toValidPackageName(input)).toBe('')
  })
})
