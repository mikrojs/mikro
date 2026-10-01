import {isExitByte} from './keys.js'

/** Enable iTerm2 Secure Keyboard Entry (prevents other apps from intercepting keystrokes) */
function setSecureKeyboardEntry(enabled: boolean) {
  process.stdout.write(`\x1b]1337;SetSecureKeyboardEntry=${enabled ? 1 : 0}\x07`)
}

/** What one chunk of raw input does to the value typed so far. `done` is the
 *  final value: '' when the prompt was left with Ctrl+C, Ctrl+D or Ctrl+Q. */
export function secretInputStep(buf: string, ch: string): {buf: string} | {done: string} {
  if (ch === '\r' || ch === '\n') return {done: buf}
  if (ch === '\x7f' || ch === '\b') return {buf: buf.slice(0, -1)}
  if (isExitByte(ch)) return {done: ''}
  // An escape sequence (an arrow key) is not part of a secret
  if (ch.startsWith('\x1b')) return {buf}
  // A paste arrives as one chunk; control characters in it are dropped
  return {buf: buf + [...ch].filter((c) => c >= ' ' && c !== '\x7f').join('')}
}

/** Read a secret value from stdin without echoing keystrokes. Empty when the
 *  prompt was left with Ctrl+C, Ctrl+D or Ctrl+Q. */
export async function readSecretValue(prompt: string): Promise<string> {
  process.stdout.write(prompt)
  setSecureKeyboardEntry(true)
  return new Promise<string>((resolve) => {
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    if (stdin.isTTY) stdin.setRawMode(true)

    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
      setSecureKeyboardEntry(false)
    }

    let buf = ''
    const onData = (chunk: Buffer) => {
      const ch = chunk.toString()
      const step = secretInputStep(buf, ch)
      if ('buf' in step) {
        buf = step.buf
        return
      }
      if (ch === '\r' || ch === '\n') process.stdout.write('\n')
      cleanup()
      resolve(step.done)
    }
    stdin.on('data', onData)
  })
}
