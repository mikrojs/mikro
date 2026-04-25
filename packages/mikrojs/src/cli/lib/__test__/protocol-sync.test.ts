/**
 * Validates that protocol constants in TypeScript match the C++ header.
 * If this test fails, the C++ defines in private.h and the TS exports in
 * protocol.ts have diverged — update both to match.
 */
import {readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'
import {fileURLToPath} from 'node:url'

import {describe, expect, it} from 'vitest'

import * as proto from '../protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Parse #define MIK_XXX 0xNN from the C++ header */
function parseCppDefines(source: string): Map<string, number> {
  const map = new Map<string, number>()
  for (const match of source.matchAll(/^#define\s+(MIK_\w+)\s+(0x[0-9a-fA-F]+|\d+)/gm)) {
    map.set(match[1]!, parseInt(match[2]!))
  }
  return map
}

/** Map TS constant names to C++ #define names */
const TS_TO_CPP: Record<string, string> = {
  CTRL_R: 'MIK_CTRL_R',
  MSG_READY: 'MIK_MSG_READY',
  MSG_LOG: 'MIK_MSG_LOG',
  MSG_WARN: 'MIK_MSG_WARN',
  MSG_ERROR: 'MIK_MSG_ERROR',
  MSG_RESULT: 'MIK_MSG_RESULT',
  MSG_INFO: 'MIK_MSG_INFO',
  MSG_DEBUG: 'MIK_MSG_DEBUG',
  MSG_COMPLETIONS: 'MIK_MSG_COMPLETIONS',
  MSG_EVAL_ERROR: 'MIK_MSG_EVAL_ERROR',
  MSG_PROMPT: 'MIK_MSG_PROMPT',
  MSG_TEST: 'MIK_MSG_TEST',
  MSG_MANIFEST_DONE: 'MIK_MSG_MANIFEST_DONE',
  MSG_OK: 'MIK_MSG_OK',
  MSG_ERR: 'MIK_MSG_ERR',
  MSG_CHECKSUM_RESULT: 'MIK_MSG_CHECKSUM_RESULT',
  MSG_CONFIG_ENTRIES: 'MIK_MSG_CONFIG_ENTRIES',
  CMD_EVAL: 'MIK_CMD_EVAL',
  CMD_COMPLETE: 'MIK_CMD_COMPLETE',
  CMD_DIRECTIVE: 'MIK_CMD_DIRECTIVE',
  CMD_EXIT: 'MIK_CMD_EXIT',
  CMD_HELLO: 'MIK_CMD_HELLO',
  CMD_DEPLOY_PUT: 'MIK_CMD_DEPLOY_PUT',
  CMD_DEPLOY_PUT_CHUNK: 'MIK_CMD_DEPLOY_PUT_CHUNK',
  CMD_DEPLOY_DONE: 'MIK_CMD_DEPLOY_DONE',
  CMD_DEPLOY_ABORT: 'MIK_CMD_DEPLOY_ABORT',
  CMD_DEPLOY_ERASE: 'MIK_CMD_DEPLOY_ERASE',
  CMD_DEPLOY_KEEP: 'MIK_CMD_DEPLOY_KEEP',
  CMD_DEPLOY_CHECKSUM: 'MIK_CMD_DEPLOY_CHECKSUM',
  CMD_RESTART: 'MIK_CMD_RESTART',
  CMD_RUNTIME_PAUSE: 'MIK_CMD_RUNTIME_PAUSE',
  CMD_RUNTIME_RESUME: 'MIK_CMD_RUNTIME_RESUME',
  CMD_CONFIG_LIST: 'MIK_CMD_CONFIG_LIST',
  CMD_CONFIG_SET: 'MIK_CMD_CONFIG_SET',
  CMD_CONFIG_DELETE: 'MIK_CMD_CONFIG_DELETE',
  ENV_FLAG_SECRET: 'MIK_ENV_FLAG_SECRET',
}

describe('protocol constants sync', () => {
  const headerPath = join(__dirname, '../../../../../@mikrojs/native/include/mikrojs/private.h')
  const header = readFileSync(headerPath, 'utf-8')
  const cppDefines = parseCppDefines(header)

  for (const [tsName, cppName] of Object.entries(TS_TO_CPP)) {
    it(`${tsName} matches ${cppName}`, () => {
      const tsValue = (proto as Record<string, unknown>)[tsName]
      const cppValue = cppDefines.get(cppName)
      expect(cppValue, `${cppName} not found in private.h`).toBeDefined()
      expect(tsValue, `${tsName} not exported from protocol.ts`).toBeDefined()
      expect(tsValue).toBe(cppValue)
    })
  }

  it('no C++ protocol constants missing from TS', () => {
    const cppNames = new Set(Object.values(TS_TO_CPP))
    const missing: string[] = []
    for (const [name] of cppDefines) {
      if (
        (name.startsWith('MIK_MSG_') ||
          name.startsWith('MIK_CMD_') ||
          name === 'MIK_CTRL_R' ||
          name === 'MIK_ENV_FLAG_SECRET') &&
        !cppNames.has(name)
      ) {
        missing.push(name)
      }
    }
    expect(missing, `C++ defines missing from TS mapping: ${missing.join(', ')}`).toEqual([])
  })
})
