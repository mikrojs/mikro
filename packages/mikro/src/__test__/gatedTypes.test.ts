import {copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'

import ts from 'typescript'
import {afterAll, describe, expect, it} from 'vitest'

/* Proof of the feature gating: mikro/wifi resolves only when the app's
 * tsconfig grants the mikro:wifi condition (via a mikro/tsconfig/<chip>
 * preset), and is "Cannot find module" under the minimal base config.
 *
 * The fixture lives next to this test as main.ts.txt: with a real .ts
 * extension the package's own tsc/eslint runs (which grant only the
 * "development" condition) would trip over the deliberately-gated import. */
describe('feature-gated type resolution', () => {
  const pkgRoot = fileURLToPath(new URL('../..', import.meta.url))
  const dir = mkdtempSync(join(tmpdir(), 'mikro-gated-types-'))
  const mainPath = join(dir, 'main.ts')

  // A fake project with the workspace's mikro package installed, so module
  // resolution goes through the package exports map like in a real app.
  mkdirSync(join(dir, 'node_modules'))
  symlinkSync(pkgRoot, join(dir, 'node_modules', 'mikro'), 'dir')
  writeFileSync(join(dir, 'package.json'), '{"type": "module"}\n')
  copyFileSync(
    fileURLToPath(new URL('fixtures/gated-types/main.ts.txt', import.meta.url)),
    mainPath,
  )

  afterAll(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  function diagnostics(customConditions: string[]) {
    const program = ts.createProgram([mainPath], {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      target: ts.ScriptTarget.ES2024,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      customConditions,
    })
    const main = program.getSourceFile(mainPath)!
    return [...program.getSyntacticDiagnostics(main), ...program.getSemanticDiagnostics(main)]
  }

  it('does not resolve mikro/wifi without the mikro:wifi condition', () => {
    const errors = diagnostics(['development'])
    expect(errors.map((d) => d.code)).toContain(2307) // TS2307: Cannot find module
  })

  it('resolves mikro/wifi under the mikro:wifi condition', () => {
    const errors = diagnostics(['mikro:wifi', 'development'])
    expect(errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([])
  })
})
