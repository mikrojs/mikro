const d = '\x1b[2m'
const y = '\x1b[43m\x1b[30m'
const b = '\x1b[1m'
const r = '\x1b[0m'

// prettier-ignore
const logo = [
  `      ${d}╷ ╷ ╷ ╷ ╷${r}`,
  `    ${d}╭─┴─┴─┴─┴─┴─╮${r}`,
  `  ${d}──│${r} ◦         ${d}├──${r}`,
  `  ${d}──┤${r}   ${y}     ${r}  ${d} ├──${r}`,
  `  ${d}──┤${r}   ${y}  ${b}JS${r}${y} ${r}  ${d} ├──${r}`,
  `  ${d}──┤${r}           ${d}├──${r}`,
  `    ${d}╰─┬─┬─┬─┬─┬─╯${r}`,
  `      ${d}╵ ╵ ╵ ╵ ╵${r}`,
]

export function printLogo() {
  // eslint-disable-next-line no-console
  console.log()
  for (const line of logo) {
    // eslint-disable-next-line no-console
    console.log(line)
  }
  // eslint-disable-next-line no-console
  console.log()
}
