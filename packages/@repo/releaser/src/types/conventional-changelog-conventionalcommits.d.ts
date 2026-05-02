// Minimal types for the conventionalcommits preset. The package ships no
// upstream types and no @types/ package exists. We only consume `parser`
// (parserOpts), so that's all that's typed here.
declare module 'conventional-changelog-conventionalcommits' {
  import type {ParserOptions} from 'conventional-commits-parser'

  interface Preset {
    parser: ParserOptions
  }

  export default function preset(): Promise<Preset>
}
