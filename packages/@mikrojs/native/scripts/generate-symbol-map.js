/* eslint-disable no-console */
import {execFileSync, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'

/**
 * Generate a compact symbol map from an ELF for offline panic-trace decoding.
 *
 * Toolchain-agnostic: takes a binutils prefix (e.g. "riscv32-esp-elf-",
 * "xtensa-esp32-elf-", "arm-none-eabi-") so the same script works for any
 * target a future port (RP2350, etc.) might add.
 *
 * Usage: node generate-symbol-map.js <elf> <out.json> <toolchain-prefix> [chip]
 */

const [, , elfPath, outPath, toolchainPrefix, chip = ''] = process.argv

if (!elfPath || !outPath || !toolchainPrefix) {
  console.error('Usage: node generate-symbol-map.js <elf> <out.json> <toolchain-prefix> [chip]')
  process.exit(1)
}

const nm = `${toolchainPrefix}nm`
const addr2line = `${toolchainPrefix}addr2line`

const elfBuf = readFileSync(elfPath)
const elfHash = createHash('sha256').update(elfBuf).digest('hex')

// nm -S --defined-only --print-size: "ADDR SIZE T name"
// Symbols without a size (size = 0) are skipped — they're typically labels,
// not real functions, and would only pollute the lookup table.
const nmOut = execFileSync(nm, ['-S', '--defined-only', '--print-size', elfPath], {
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})

const rawFuncs = []
const addrs = []
let codeMin = Infinity
let codeMax = 0

for (const line of nmOut.split('\n')) {
  const m = line.match(/^([0-9a-f]+)\s+([0-9a-f]+)\s+([tTwW])\s+(.+)$/)
  if (!m) continue
  const start = parseInt(m[1], 16)
  const size = parseInt(m[2], 16)
  if (size === 0) continue
  rawFuncs.push({start, size, mangled: m[4]})
  addrs.push('0x' + start.toString(16))
  if (start < codeMin) codeMin = start
  if (start + size > codeMax) codeMax = start + size
}

if (rawFuncs.length === 0) {
  console.error('No function symbols found in ELF — nothing to do.')
  process.exit(1)
}

// Resolve every function entry's file:line in a single addr2line invocation.
// `-f` = function name, `-C` = demangle, `-s` = base names only (we keep
// full paths from the file column instead — `-s` would shorten file paths).
// Actually we want full paths: drop -s.
const a2l = spawnSync(addr2line, ['-f', '-C', '-e', elfPath], {
  input: addrs.join('\n') + '\n',
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024,
})

if (a2l.status !== 0) {
  console.error(`addr2line failed: ${a2l.stderr}`)
  process.exit(1)
}

// addr2line output: two lines per input address — function name, then file:line
const a2lLines = a2l.stdout.split('\n')

const fileIdx = new Map()
const files = []
const nameIdx = new Map()
const names = []

function internFile(f) {
  let i = fileIdx.get(f)
  if (i === undefined) {
    i = files.length
    files.push(f)
    fileIdx.set(f, i)
  }
  return i
}

function internName(n) {
  let i = nameIdx.get(n)
  if (i === undefined) {
    i = names.length
    names.push(n)
    nameIdx.set(n, i)
  }
  return i
}

const funcs = [] // [start, size, nameIdx, fileIdx, line]

for (let i = 0; i < rawFuncs.length; i++) {
  const fn = rawFuncs[i]
  const fname = (a2lLines[i * 2] || '').trim()
  const floc = (a2lLines[i * 2 + 1] || '').trim()

  // addr2line emits "??" when DWARF info is missing.
  const displayName = fname && fname !== '??' ? fname : fn.mangled
  let fIdx = -1
  let lineNo = 0
  if (floc && floc !== '??:?' && floc !== '??:0') {
    // "path/to/file.cpp:123" (or "...:123 (discriminator N)")
    const colon = floc.lastIndexOf(':')
    if (colon > 0) {
      const file = floc.slice(0, colon)
      const lineStr = floc.slice(colon + 1).split(/\s/)[0]
      const parsed = parseInt(lineStr, 10)
      if (file && file !== '??' && Number.isFinite(parsed)) {
        fIdx = internFile(file)
        lineNo = parsed
      }
    }
  }
  funcs.push([fn.start, fn.size, internName(displayName), fIdx, lineNo])
}

funcs.sort((a, b) => a[0] - b[0])

const out = {
  v: 1,
  chip,
  elfHash,
  codeStart: codeMin,
  codeEnd: codeMax,
  files,
  names,
  funcs,
}

writeFileSync(outPath, JSON.stringify(out))
console.log(
  `Wrote ${outPath}: ${funcs.length} funcs, ${files.length} files, ${names.length} names, ` +
    `code range 0x${codeMin.toString(16)}-0x${codeMax.toString(16)}`,
)
