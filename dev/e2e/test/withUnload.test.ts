import {withUnload} from 'mikro/module'
import {memoryUsage} from 'mikro/sys'
import {assert, describe, test} from 'mikro/test'

type Evals = Record<string, number>

describe('withUnload', () => {
  test('rejects a builtin (anchored) module', async () => {
    // Builtins (mikrojs/*, native:*) are anchored and cannot be unloaded.
    await assert.rejects(() => withUnload(import('mikro/result'), (m) => m))
  })

  test('unloads a nested module tree and reclaims its heap', async () => {
    const g = globalThis as unknown as {__phaseEvals?: Evals}

    const before = memoryUsage().heapUsed

    // index -> sensor -> util, index -> report -> util (diamond). The callback
    // returns the heap reading taken while the tree is still loaded.
    const loaded = await withUnload(import('./fixtures/phase/index.js'), (phase) => {
      assert.equal(phase.run(), 'entry-000000/entry-000003')
      return memoryUsage().heapUsed
    })

    const after = memoryUsage().heapUsed

    // Whole tree evaluated exactly once.
    assert.equal(g.__phaseEvals?.index, 1, 'index evaluated once')
    assert.equal(g.__phaseEvals?.sensor, 1, 'sensor evaluated once')
    assert.equal(g.__phaseEvals?.report, 1, 'report evaluated once')
    assert.equal(g.__phaseEvals?.util, 1, 'util evaluated once')

    // The tree added real heap while loaded; it's reclaimed by the time
    // withUnload resolves. Scale-relative so it stays robust.
    const grew = loaded - before
    const retained = after - before
    assert.truthy(grew > 4096, `phase tree should add heap (added ${grew} bytes)`)
    assert.truthy(
      retained < grew / 2,
      `should reclaim most of the tree (retained ${retained} of ${grew} bytes)`,
    )

    // Re-loading re-evaluates every module — proving the unload of the root AND
    // its now-orphaned transitive deps was real.
    const again = await withUnload(import('./fixtures/phase/index.js'), (p) => p.run())
    assert.equal(again, 'entry-000000/entry-000003')
    assert.equal(g.__phaseEvals?.index, 2, 'index re-evaluated after unload')
    assert.equal(g.__phaseEvals?.sensor, 2, 'sensor re-evaluated after unload')
    assert.equal(g.__phaseEvals?.report, 2, 'report re-evaluated after unload')
    assert.equal(g.__phaseEvals?.util, 2, 'util re-evaluated after unload')
  })

  test('does not unload a dep still imported by a live module', async () => {
    const g = globalThis as unknown as {__phaseEvals?: Evals}

    // holder imports ./dep.js and is kept alive for the whole test.
    const holder = await import('./fixtures/shared/holder.js')
    assert.equal(g.__phaseEvals?.sharedHolder, 1)
    assert.equal(g.__phaseEvals?.sharedDep, 1)

    // phase also imports ./dep.js, but we dispose it.
    const result = await withUnload(import('./fixtures/shared/phase.js'), (p) => p.compute())
    assert.equal(result, 14)
    assert.equal(g.__phaseEvals?.sharedPhase, 1)

    // The disposed phase re-evaluates on re-load (it was unloaded)...
    const again = await withUnload(import('./fixtures/shared/phase.js'), (p) => p.compute())
    assert.equal(again, 14)
    assert.equal(g.__phaseEvals?.sharedPhase, 2, 'phase was unloaded and reloaded')

    // ...but dep was NOT unloaded, because holder still imports it: it is not
    // re-evaluated, and holder keeps working against the same instance.
    assert.equal(g.__phaseEvals?.sharedDep, 1, 'shared dep survived: holder still imports it')
    assert.equal(holder.read(), 7)
  })
})
