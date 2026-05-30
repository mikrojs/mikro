import {describe, expect, it} from 'vitest'

import {parseDotenv} from '../dotenv.js'

describe('parseDotenv', () => {
  it('parses simple KEY=VALUE pairs', () => {
    expect(parseDotenv('FOO=bar\nBAZ=qux\n')).to.deep.equal([
      {key: 'FOO', value: 'bar', noSecret: false},
      {key: 'BAZ', value: 'qux', noSecret: false},
    ])
  })

  it('strips matching quotes', () => {
    expect(parseDotenv('A="hi"\nB=\'ho\'\n')).to.deep.equal([
      {key: 'A', value: 'hi', noSecret: false},
      {key: 'B', value: 'ho', noSecret: false},
    ])
  })

  it('skips comments and blank lines', () => {
    expect(parseDotenv('# top\n\nFOO=bar\n# trailing\n')).to.deep.equal([
      {key: 'FOO', value: 'bar', noSecret: false},
    ])
  })

  it('marks an entry @no-secret via comment directly above', () => {
    const src = '# @no-secret\nFOO=bar\n'
    expect(parseDotenv(src)).to.deep.equal([{key: 'FOO', value: 'bar', noSecret: true}])
  })

  it('@no-secret applies only to the next entry', () => {
    const src = '# @no-secret\nFOO=bar\nBAZ=qux\n'
    expect(parseDotenv(src)).to.deep.equal([
      {key: 'FOO', value: 'bar', noSecret: true},
      {key: 'BAZ', value: 'qux', noSecret: false},
    ])
  })

  it('@no-secret survives across other comment lines in the same block', () => {
    const src = '# wifi name\n# @no-secret\n# visible for debugging\nFOO=bar\n'
    expect(parseDotenv(src)).to.deep.equal([{key: 'FOO', value: 'bar', noSecret: true}])
  })

  it('blank line breaks the @no-secret annotation', () => {
    const src = '# @no-secret\n\nFOO=bar\n'
    expect(parseDotenv(src)).to.deep.equal([{key: 'FOO', value: 'bar', noSecret: false}])
  })

  it('@no-secret matches case-sensitively as a token', () => {
    expect(parseDotenv('# no-secret\nFOO=bar\n')).to.deep.equal([
      {key: 'FOO', value: 'bar', noSecret: false},
    ])
    expect(parseDotenv('# @NO-SECRET\nFOO=bar\n')).to.deep.equal([
      {key: 'FOO', value: 'bar', noSecret: false},
    ])
  })
})
