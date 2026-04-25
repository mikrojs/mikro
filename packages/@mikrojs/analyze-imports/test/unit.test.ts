import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

import {describe, expect, it} from 'vitest'

import {nodeFileTrace} from '../src/index.js'

const testDir = join(import.meta.dirname, 'unit')
const pkgDir = join(import.meta.dirname, '..')
const unitTestDirs = readdirSync(testDir).filter((d) => d !== 'asset-extensions')

describe('unit tests', () => {
  for (const testName of unitTestDirs) {
    const unitPath = join(testDir, testName)

    it(`should correctly trace ${testName}`, async () => {
      const inputFiles = readdirSync(unitPath).filter((f) => f.startsWith('input.'))
      const {fileList, reasons} = await nodeFileTrace(
        inputFiles.map((f) => join(unitPath, f)),
        {
          processCwd: process.cwd(),
          base: pkgDir,
          paths: {
            dep: join(testDir, 'esm-paths/esm-dep.js'),
            'dep/': join(testDir, 'esm-paths-trailer/'),
          },
        },
      )
      const expected = JSON.parse(
        readFileSync(join(unitPath, 'output.json')).toString(),
      ) as string[]
      const sortedFileList = [...fileList].sort()
      const sortedExpected = [...expected].sort()

      expect(sortedFileList).toEqual(sortedExpected)
    })
  }
})

describe('assetExtensions', () => {
  it('should include asset files but not parse them for imports', async () => {
    const unitPath = join(testDir, 'asset-extensions')
    const {fileList, warnings} = await nodeFileTrace([join(unitPath, 'input.js')], {
      processCwd: unitPath,
      base: unitPath,
      assetExtensions: ['.css', '.svg'],
    })

    expect([...fileList].sort()).toEqual(
      ['dep.js', 'icon.svg', 'input.js', 'package.json', 'styles.css'].sort(),
    )
    // No warnings about failing to parse CSS/SVG
    expect([...warnings]).toEqual([])
  })

  it('should produce parse warnings for non-JS files when assetExtensions is not set', async () => {
    const unitPath = join(testDir, 'asset-extensions')
    const {warnings} = await nodeFileTrace([join(unitPath, 'input.js')], {
      processCwd: unitPath,
      base: unitPath,
    })

    // Without assetExtensions, CSS and SVG files will fail to parse
    expect(warnings.size).toBeGreaterThan(0)
  })
})

describe('symlink tests', () => {
  it('should follow symlinks outside of base/cwd', async () => {
    // Use node_modules-symlink-import with base narrowed to the fixture directory,
    // making the @b/c symlink target (test/symlink/c) outside base.
    // Files are always emitted at their real path, so @b/c files are ignored.
    const unitPath = join(testDir, 'node_modules-symlink-import')
    const {fileList} = await nodeFileTrace([join(unitPath, 'input.js')], {
      processCwd: unitPath,
      base: unitPath,
    })

    expect([...fileList].sort()).toEqual(
      [
        // '../../symlink/text.txt', // <-- this should warn as importing outside of package boundary can't work
        'input.js',
        'node_modules/@b/c/b-c.js',
        'node_modules/@b/c/node_modules/nested-dep/index.js',
        'node_modules/@b/c/node_modules/nested-dep/package.json',
        'node_modules/@b/c/package.json',
        'node_modules/a/a.js',
        'node_modules/a/package.json',
        'package.json',
      ].sort(),
    )
  })
})
