import {mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, describe, expect, it} from 'vitest'

import {compileBytecode, MikroRuntime} from '../../addon/index.js'

const TEST_DIR = join(tmpdir(), 'mikrojs-native-test')

describe('MikroRuntime', () => {
  let runtime: MikroRuntime | undefined

  afterEach(() => {
    runtime?.dispose()
    runtime = undefined
    rmSync(TEST_DIR, {recursive: true, force: true})
  })

  it('can be created and disposed', () => {
    runtime = new MikroRuntime()
    expect(runtime).toBeDefined()
    runtime.dispose()
    runtime = undefined
  })

  it('can be created with options', () => {
    runtime = new MikroRuntime({memLimit: 4 * 1024 * 1024, stackSize: 512 * 1024})
    expect(runtime).toBeDefined()
  })

  it('can eval a simple module', () => {
    mkdirSync(TEST_DIR, {recursive: true})
    const modulePath = join(TEST_DIR, 'test.js')
    writeFileSync(modulePath, 'const x = 1 + 1;\nexport default x;\n')

    runtime = new MikroRuntime()
    runtime.evalModule(modulePath)
  })

  it('can set filesystem base path', () => {
    mkdirSync(TEST_DIR, {recursive: true})
    const modulePath = join(TEST_DIR, 'hello.js')
    writeFileSync(modulePath, 'console.log("hello from quickjs");\n')

    runtime = new MikroRuntime({fsBasePath: TEST_DIR})
    runtime.evalModule('/hello.js')
  })

  it('can set env vars', () => {
    mkdirSync(TEST_DIR, {recursive: true})
    const modulePath = join(TEST_DIR, 'env.js')
    writeFileSync(modulePath, 'const env = import.meta.env;\n')

    runtime = new MikroRuntime({env: {FOO: 'bar'}})
    runtime.evalModule(modulePath)
  })

  it('throws on missing module', () => {
    runtime = new MikroRuntime()
    expect(() => runtime!.evalModule('/nonexistent.js')).toThrow()
  })

  it('mikrojs/result prototype methods work end-to-end', () => {
    mkdirSync(TEST_DIR, {recursive: true})

    // Exercise the shared Result prototype installed by mik_result.cpp.
    // Writes the outcomes into globals so the harness can't silently pass.
    const source = [
      "import {ok, err} from 'mikrojs/result'",
      'const mapped = ok(10).map(n => n * 2)',
      'const matched = err("boom").match({ok: () => "nope", err: (e) => `got ${e}`})',
      'let panicked = null',
      'try { err("bad").orPanic("panic msg") } catch (e) { panicked = e }',
      'globalThis.__mappedValue = mapped.value',
      'globalThis.__mappedOk = mapped.ok',
      'globalThis.__matched = matched',
      'globalThis.__panicName = panicked?.name',
      'globalThis.__panicCause = panicked?.cause',
    ].join('\n')
    const bytecode = compileBytecode(source, '/result_test.js', ['mikrojs/result'])
    writeFileSync(join(TEST_DIR, 'result_test.bjs'), bytecode)

    runtime = new MikroRuntime({fsBasePath: TEST_DIR})
    runtime.evalModule('/result_test.bjs')
    runtime.loopOnce()

    expect(runtime.evalScript('globalThis.__mappedValue')).toBe('20')
    expect(runtime.evalScript('globalThis.__mappedOk')).toBe('true')
    expect(runtime.evalScript('globalThis.__matched')).toBe('got boom')
    expect(runtime.evalScript('globalThis.__panicName')).toBe('PanicError')
    expect(runtime.evalScript('globalThis.__panicCause')).toBe('bad')
  })

  it('dynamic import() works from bytecode-compiled module', () => {
    mkdirSync(join(TEST_DIR, 'app'), {recursive: true})

    // Compile a dependency module to bytecode
    const depSource = 'export const value = 42;\n'
    const depBytecode = compileBytecode(depSource, '/app/dep.js', [])
    writeFileSync(join(TEST_DIR, 'app', 'dep.bjs'), depBytecode)

    // Compile a main module that uses dynamic import() — this is the pattern
    // that failed with "no function filename for import()" when bytecode was
    // serialized with JS_WRITE_OBJ_STRIP_DEBUG
    const mainSource = [
      'const name = "./dep" + ".js";',
      'const {value} = await import(name);',
      'globalThis.__dynamicImportResult = value;',
    ].join('\n')
    const mainBytecode = compileBytecode(mainSource, '/app/main.js', [])
    writeFileSync(join(TEST_DIR, 'app', 'main.bjs'), mainBytecode)

    runtime = new MikroRuntime({fsBasePath: TEST_DIR})
    // evalModule starts execution; loopOnce() processes the dynamic import job
    runtime.evalModule('/app/main.bjs')
    runtime.loopOnce()
  })
})
