import {assert, describe, test} from 'mikro/test'

describe('AbortController', () => {
  test('signal starts not aborted', () => {
    const ac = new AbortController()
    assert.equal(ac.signal.aborted, false)
  })

  test('abort sets signal.aborted', () => {
    const ac = new AbortController()
    ac.abort()
    assert.equal(ac.signal.aborted, true)
  })

  test('abort with reason', () => {
    const ac = new AbortController()
    ac.abort('test reason')
    assert.equal(ac.signal.reason, 'test reason')
  })

  test('signal fires abort event', () => {
    const ac = new AbortController()
    let fired = false
    ac.signal.addEventListener('abort', () => {
      fired = true
    })
    ac.abort()
    assert.equal(fired, true)
  })

  test('throwIfAborted throws when aborted', () => {
    const ac = new AbortController()
    ac.abort()
    assert.throws(() => ac.signal.throwIfAborted())
  })

  test('throwIfAborted does not throw when not aborted', () => {
    const ac = new AbortController()
    ac.signal.throwIfAborted() // should not throw
  })

  test('AbortSignal.abort() creates pre-aborted signal', () => {
    const signal = AbortSignal.abort()
    assert.equal(signal.aborted, true)
  })

  test('AbortSignal.timeout() aborts after delay', async () => {
    const signal = AbortSignal.timeout(20)
    assert.equal(signal.aborted, false)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(signal.aborted, true)
  })

  test('AbortSignal.any() aborts when any child aborts', () => {
    const ac = new AbortController()
    const combined = AbortSignal.any([ac.signal])
    assert.equal(combined.aborted, false)
    ac.abort()
    assert.equal(combined.aborted, true)
  })
})
