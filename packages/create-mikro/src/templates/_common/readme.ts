import {mikroCommand as mikro, type PkgManager} from '../../pkg-manager.js'

export interface ReadmeOptions {
  projectName: string
  description: string
  pm: PkgManager
  hardware?: string
  wiring?: string
  setup?: string
  /** The app is its own firmware project, for this chip. */
  firmware?: {chip: string}
}

export function readme(options: ReadmeOptions) {
  const {projectName, description, pm, hardware, wiring, setup, firmware} = options

  const sections: string[] = []

  sections.push(`# ${projectName}\n\n${description}`)

  if (hardware) {
    sections.push(`## Hardware\n\n${hardware}`)
  }

  if (wiring) {
    sections.push(`## Wiring\n\n${wiring}`)
  }

  if (setup) {
    sections.push(`## Setup\n\n${setup}`)
  }

  if (firmware) {
    sections.push(`## Getting started

Install dependencies:

\`\`\`sh
${pm} install
\`\`\`

Build the firmware and flash it:

\`\`\`sh
${mikro(pm, `idf set-target ${firmware.chip}`)}
${mikro(pm, 'idf build flash')}
\`\`\`

\`mikro idf\` runs ESP-IDF's \`idf.py\` with these arguments, through EIM when ESP-IDF is not active in the shell.

Start developing:

\`\`\`sh
${mikro(pm, 'dev')}
\`\`\``)

    sections.push(`## Firmware

\`CMakeLists.txt\` builds this project's own firmware. To compile in a native module, add its package to \`package.json\` and list it in \`MIKROJS_NATIVE_MODULES\` in \`CMakeLists.txt\`. See [Custom Firmware](https://mikrojs.dev/develop/custom-firmware).`)
  } else {
    sections.push(`## Getting started

Install dependencies:

\`\`\`sh
${pm} install
\`\`\`

Flash firmware and start developing:

\`\`\`sh
${mikro(pm, 'dev')}
\`\`\``)
  }

  sections.push(`## Commands

- \`${mikro(pm, 'dev')}\` — develop on connected device
- \`${mikro(pm, 'deploy')}\` — build and deploy to device
- \`${mikro(pm, 'console')}\` — open REPL on device
- \`${mikro(pm, 'env set KEY value')}\` — set environment variable on device`)

  sections.push(`## Learn more

- [Mikro.js documentation](https://mikrojs.dev)
- [API reference](https://mikrojs.dev/api/)
- [Examples](https://mikrojs.dev/examples/)`)

  return sections.join('\n\n') + '\n'
}
