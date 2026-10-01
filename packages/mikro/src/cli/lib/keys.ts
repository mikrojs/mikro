/**
 * Every Ctrl key the CLI handles. A handler asks for a binding by name
 * (`isKey('restart', ch, key)`), so a search for the name finds all that the
 * key does, and the REPL's `/help` lists the keys from here.
 */

interface Binding {
  ch: string
  shift?: true
  label: string
  /** What the key does, as `/help` puts it */
  does: string
}

/** The Alt key as the keyboard names it */
const ALT = process.platform === 'darwin' ? 'Option' : 'Alt'

export const KEYS = {
  // The three ways out. Ctrl+D and Ctrl+Q exit; Ctrl+C first stops what there
  // is to stop (typed input, a flash in progress), and exits when there is
  // nothing.
  cancel: {ch: 'c', label: 'Ctrl+C', does: 'Clear the line, or exit when pressed twice'},
  exit: {ch: 'd', label: 'Ctrl+D', does: 'Exit, on an empty line'},
  quit: {ch: 'q', label: 'Ctrl+Q', does: 'Exit'},

  restart: {ch: 'r', label: 'Ctrl+R', does: 'Restart the device'},
  // The same key as fullDeploy: ask for that one to tell them apart
  deploy: {ch: 's', label: 'Ctrl+S', does: 'Deploy what changed'},
  fullDeploy: {
    ch: 's',
    shift: true,
    label: 'Ctrl+Shift+S',
    does: 'Deploy every file again (where supported)',
  },
  clear: {ch: 'l', label: 'Ctrl+L', does: 'Clear the console'},
  newline: {
    ch: 'j',
    label: 'Ctrl+J',
    does: `Add a line (also Shift+Enter or ${ALT}+Enter, where supported)`,
  },

  lineStart: {ch: 'a', label: 'Ctrl+A', does: 'Go to the start of the line'},
  lineEnd: {ch: 'e', label: 'Ctrl+E', does: 'Go to the end of the line'},
  // The text fields of the env editor only
  deleteToStart: {ch: 'u', label: 'Ctrl+U', does: 'Delete to the start of the line'},
} as const satisfies Record<string, Binding>

type KeyName = keyof typeof KEYS

const EXIT_KEYS = ['cancel', 'exit', 'quit'] as const satisfies readonly KeyName[]

/** The keys the REPL handles, in the order `/help` lists them. */
const REPL_KEYS = [
  'restart',
  'deploy',
  'fullDeploy',
  'clear',
  'newline',
  'lineStart',
  'lineEnd',
  'cancel',
  'exit',
  'quit',
] as const satisfies readonly KeyName[]

/** The modifiers of a key press, as Ink and the REPL's reducer report them. */
interface Modifiers {
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
}

export function isKey(name: KeyName, ch: string, key: Modifiers): boolean {
  const binding: Binding = KEYS[name]
  if (!key.ctrl) return false
  if (binding.shift && !key.shift) return false
  // Some terminals send the letter as typed, so with Shift held it is `S`
  return ch.toLowerCase() === binding.ch
}

/** Ctrl+C, Ctrl+D or Ctrl+Q: what leaves a screen that has nothing to stop. */
export function isExitKey(ch: string, key: Modifiers): boolean {
  return EXIT_KEYS.some((name) => isKey(name, ch, key))
}

/** The same three keys as a raw terminal sends them, for a prompt that reads
 *  stdin itself. */
export function isExitByte(ch: string): boolean {
  if (ch.length !== 1) return false
  return EXIT_KEYS.some((name) => ch.charCodeAt(0) === (KEYS[name].ch.charCodeAt(0) & 0x1f))
}

/** `ch` when it was typed without Ctrl or Alt, else ''. Screens that take
 *  letters as commands (y, n, d) go through this, so Ctrl+D is not `d`. */
export function plainKey(ch: string, key: Modifiers): string {
  return key.ctrl || key.meta ? '' : ch
}

/** The REPL's keys, one per line, for its `/help`. `deploy`: whether Ctrl+S
 *  deploys in this REPL, as it does in `mikro dev` only. */
export function replKeysHelp(deploy: boolean): string {
  const names = REPL_KEYS.filter((name) => deploy || (name !== 'deploy' && name !== 'fullDeploy'))
  const width = Math.max(...names.map((name) => KEYS[name].label.length)) + 2
  return names.map((name) => KEYS[name].label.padEnd(width) + KEYS[name].does).join('\n')
}
