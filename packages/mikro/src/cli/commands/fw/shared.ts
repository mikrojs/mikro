import {agentError} from '../../lib/agent.js'
import {describeError, UserError} from '../../lib/errorMessage.js'
import {firmwareBuildDir, runIdf} from '../idf.js'

/** Build the firmware project in `projectDir` where `mikro idf` builds it,
 *  and return that directory; undefined when idf.py failed and the process is
 *  exiting with its code. In agent mode stdout carries only the result, so
 *  idf.py's output goes to stderr. */
export function buildFirmware(
  projectDir: string,
  command: string,
  jsonOutput: boolean,
): string | undefined {
  const buildDir = firmwareBuildDir(projectDir)
  const code = runIdf(['-B', buildDir, 'build'], jsonOutput ? ['inherit', 2, 2] : 'inherit')
  if (code !== 0) {
    // idf.py, or runIdf when it found neither idf.py nor eim, has said what went wrong.
    if (jsonOutput) agentError(command, `idf.py build exited with code ${code}`)
    process.exit(code)
    return undefined
  }
  return buildDir
}

/** Report a failed `mikro fw` command and exit with 1. */
export function failFw(command: string, err: unknown, jsonOutput: boolean): void {
  if (jsonOutput) {
    agentError(command, describeError(err))
  } else if (err instanceof UserError) {
    // eslint-disable-next-line no-console
    console.error(`Error: ${describeError(err)}`)
  } else {
    // eslint-disable-next-line no-console
    console.error('Error:', err)
  }
  process.exit(1)
}
