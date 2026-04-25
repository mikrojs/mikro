import type {ErrResult, OkResult, Result} from '../result/types.js'

export type TestFn = () => void | Promise<void>

export interface TestOptions {
  timeout?: number
}

export interface Assert {
  /** Strict equality (Object.is) */
  equal(actual: unknown, expected: unknown, message?: string): void
  /** Strict inequality */
  notEqual(actual: unknown, unexpected: unknown, message?: string): void
  /** Truthy check */
  truthy(value: unknown, message?: string): void
  /** Deep equality via JSON.stringify comparison */
  deepEqual(actual: unknown, expected: unknown, message?: string): void
  /** Expect function to throw, returns the error */
  throws(fn: () => void, message?: string): Error
  /** Expect promise to reject, returns the error */
  rejects(fn: () => Promise<unknown>, message?: string): Promise<Error>
  /** typeof check */
  type(value: unknown, expected: string, message?: string): void
  /** instanceof check */
  instance(value: unknown, ctor: new (...args: any[]) => any, message?: string): void
  /** Assert a Result is ok. Narrows r to OkResult; read r.value afterwards. */
  ok<T, E>(r: Result<T, E>, message?: string): asserts r is OkResult<T>
  /** Assert a Result is an error. Narrows r to ErrResult; read r.error afterwards. */
  err<T, E>(r: Result<T, E>, message?: string): asserts r is ErrResult<E>
}

export declare const assert: Assert

export declare function describe(name: string, fn: () => void): void
// eslint-disable-next-line @typescript-eslint/no-namespace -- needed for describe.skip() syntax
export declare namespace describe {
  function skip(name: string, fn: () => void): void
  // eslint-disable-next-line @typescript-eslint/no-namespace -- needed for describe.skip.each() syntax
  namespace skip {
    function each<T>(cases: T[]): (name: string, fn: (value: T, index: number) => void) => void
  }
  function only(name: string, fn: () => void): void
  // eslint-disable-next-line @typescript-eslint/no-namespace -- needed for describe.only.each() syntax
  namespace only {
    function each<T>(cases: T[]): (name: string, fn: (value: T, index: number) => void) => void
  }
  function todo(name: string, fn: () => void): void
  // eslint-disable-next-line @typescript-eslint/no-namespace -- needed for describe.todo.each() syntax
  namespace todo {
    function each<T>(cases: T[]): (name: string, fn: (value: T, index: number) => void) => void
  }
  function fixme(name: string, fn: () => void): void
  // eslint-disable-next-line @typescript-eslint/no-namespace -- needed for describe.fixme.each() syntax
  namespace fixme {
    function each<T>(cases: T[]): (name: string, fn: (value: T, index: number) => void) => void
  }
  function skipIf(condition: unknown): typeof describe
  function runIf(condition: unknown): typeof describe
  function each<T>(cases: T[]): (name: string, fn: (value: T, index: number) => void) => void
}

export declare function test(name: string, fn: TestFn, options?: TestOptions): void
// eslint-disable-next-line @typescript-eslint/no-namespace -- needed for test.skip() syntax
export declare namespace test {
  function skip(name: string, fn: TestFn, options?: TestOptions): void
  // eslint-disable-next-line @typescript-eslint/no-namespace -- needed for test.skip.each() syntax
  namespace skip {
    function each<T>(
      cases: T[],
    ): (name: string, fn: (value: T, index: number) => void | Promise<void>) => void
  }
  function only(name: string, fn: TestFn, options?: TestOptions): void
  // eslint-disable-next-line @typescript-eslint/no-namespace -- needed for test.only.each() syntax
  namespace only {
    function each<T>(
      cases: T[],
    ): (name: string, fn: (value: T, index: number) => void | Promise<void>) => void
  }
  function fixme(name: string, fn: TestFn, options?: TestOptions): void
  // eslint-disable-next-line @typescript-eslint/no-namespace -- needed for test.fixme.each() syntax
  namespace fixme {
    function each<T>(
      cases: T[],
    ): (name: string, fn: (value: T, index: number) => void | Promise<void>) => void
  }
  function skipIf(condition: unknown): typeof test
  function runIf(condition: unknown): typeof test
  function todo(name: string): void
  function each<T>(
    cases: T[],
  ): (name: string, fn: (value: T, index: number) => void | Promise<void>) => void
}

export declare function beforeAll(fn: TestFn): void
export declare function afterAll(fn: TestFn): void
export declare function beforeEach(fn: TestFn): void
export declare function afterEach(fn: TestFn): void
