import {describe, expect, it} from 'vitest'

import type {MikroJSConfig} from '../../../_exports/index.js'
import {resolveConfig} from '../loadMikroConfig.js'

describe('resolveConfig', () => {
  it('returns null when no config was found', () => {
    expect(resolveConfig(null, 'production')).to.equal(null)
  })

  it('returns the base config (env stripped) when there are no overrides', () => {
    const config: MikroJSConfig = {build: {logLevel: 'warn'}, memReserved: 1024}
    expect(resolveConfig(config, 'production')).to.deep.equal(config)
  })

  it('strips the env map even when an environment has no entry', () => {
    const config: MikroJSConfig = {
      memReserved: 1024,
      env: {development: {memReserved: 2048}},
    }
    expect(resolveConfig(config, 'production')).to.deep.equal({memReserved: 1024})
  })

  it('shallow-merges the matching override over the base', () => {
    const config: MikroJSConfig = {
      memReserved: 1024,
      build: {minifier: 'esbuild', minifyLevel: 'max'},
      env: {development: {build: {minifier: 'esbuild', logLevel: 'debug'}}},
    }
    // memReserved inherited from base; build replaced wholesale (no minifyLevel).
    expect(resolveConfig(config, 'development')).to.deep.equal({
      memReserved: 1024,
      build: {minifier: 'esbuild', logLevel: 'debug'},
    })
  })

  it('replaces top-level fields wholesale, leaving unmentioned ones from the base', () => {
    const config: MikroJSConfig = {
      stackSize: 16384,
      onPanic: {mode: 'deepSleep', delay: 0, duration: 5000},
      env: {development: {onPanic: {mode: 'restart', delay: 5000}}},
    }
    expect(resolveConfig(config, 'development')).to.deep.equal({
      stackSize: 16384,
      onPanic: {mode: 'restart', delay: 5000},
    })
  })

  it('keeps environments independent', () => {
    const config: MikroJSConfig = {
      build: {minifyLevel: 'max'},
      env: {
        development: {build: {logLevel: 'debug'}},
        production: {logFile: true},
      },
    }
    expect(resolveConfig(config, 'production')).to.deep.equal({
      build: {minifyLevel: 'max'},
      logFile: true,
    })
  })

  it('resolves the test env over base, not inheriting development', () => {
    const config: MikroJSConfig = {
      memReserved: 1024,
      env: {
        development: {logFile: true},
        test: {onPanic: {mode: 'restart', delay: 0}},
      },
    }
    // test gets base + env.test; development's logFile does NOT leak in.
    expect(resolveConfig(config, 'test')).to.deep.equal({
      memReserved: 1024,
      onPanic: {mode: 'restart', delay: 0},
    })
  })
})
