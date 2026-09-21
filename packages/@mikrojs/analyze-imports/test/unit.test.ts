import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'

import {describe, expect, it} from 'vitest'

import {traceImports} from '../src/index.js'

const testDir = join(import.meta.dirname, 'unit')
// Every other fixture has to trace without a problem.
const expectedProblems: Record<string, RegExp[]> = {'syntax-err': [/^Failed to parse /]}

// Each directory is an app on disk: `input.*` are the entries, and output.json
// lists the paths that deploy.
describe('unit tests', () => {
  for (const testName of readdirSync(testDir)) {
    const unitPath = join(testDir, testName)

    it(`should correctly trace ${testName}`, async () => {
      const inputFiles = readdirSync(unitPath).filter((f) => f.startsWith('input.'))
      const {files, problems} = await traceImports(
        inputFiles.map((f) => join(unitPath, f)),
        {root: unitPath, conditions: ['node'], assetExtensions: ['.css', '.svg']},
      )
      const expected = JSON.parse(
        readFileSync(join(unitPath, 'output.json')).toString(),
      ) as string[]

      expect([...files.keys()].sort()).toEqual([...expected].sort())

      const patterns = expectedProblems[testName] ?? []
      expect(problems).toHaveLength(patterns.length)
      patterns.forEach((pattern, i) => expect(problems[i]).toMatch(pattern))
    })
  }
})
