import {prettyMs as prettyMs8, version} from '@repo/uptime'
import {short} from '@repo/uptime/formats/short'
import {sleep} from 'mikro/sleep'
import prettyMs from 'pretty-ms'

// The build resolves every package import on the host and rewrites it to a
// relative path. Each line this app prints needs the device to load the file
// that path names. test/packages.test.ts asserts the same things.
const started = Date.now()

const {greeting} = await import(started % 2 === 0 ? './lang/en.js' : './lang/no.js')
console.log(`${greeting} from @repo/uptime ${version}`)

// The build leaves a computed name alone, so this import goes through the
// device's own resolver and the package.json the build generates. The REPL
// imports packages the same way: try `await import('pretty-ms')` there.
const name = ['pretty', 'ms'].join('-')
const byName = await import(name)
console.log('pretty-ms by name is the module imported above:', byName.default === prettyMs)
console.log('pretty-ms 8 and 9 are two modules:', prettyMs8 !== prettyMs)

while (true) {
  const up = Date.now() - started
  console.log(
    `up ${prettyMs(up)} (pretty-ms 9), ${prettyMs8(up)} (pretty-ms 8), ${short(up)} (short)`,
  )
  await sleep(5000)
}
