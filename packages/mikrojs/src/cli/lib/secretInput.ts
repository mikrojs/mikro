/** Enable iTerm2 Secure Keyboard Entry (prevents other apps from intercepting keystrokes) */
function setSecureKeyboardEntry(enabled: boolean) {
  process.stdout.write(`\x1b]1337;SetSecureKeyboardEntry=${enabled ? 1 : 0}\x07`)
}

/** Read a secret value from stdin without echoing keystrokes. */
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
      if (ch === '\r' || ch === '\n') {
        process.stdout.write('\n')
        cleanup()
        resolve(buf)
      } else if (ch === '\x7f' || ch === '\b') {
        buf = buf.slice(0, -1)
      } else if (ch === '\x03') {
        cleanup()
        resolve('')
      } else {
        buf += ch
      }
    }
    stdin.on('data', onData)
  })
}
