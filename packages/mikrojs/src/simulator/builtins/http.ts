import type {BuiltinDefinition} from './types.js'

// http uses a raw source module instead of RPC because request() returns
// {ok, id, headers: Promise<...>} which can't survive JSON serialization,
// and nextMessage() yields chunks asynchronously.
export const httpBuiltin: BuiltinDefinition = {
  source: `/* eslint-disable no-console */
// Simulator stub for http
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import type {SimHttp} from 'mikrojs/sim'

let nextId = 0

export const request: SimHttp['request'] = (url, options) => {
  console.log('[sim] http.request:', options?.method ?? 'GET', url)
  return {
    ok: true as const,
    id: nextId++,
    headers: Promise.resolve({
      ok: true as const,
      value: {status: 200, headers: [] as [string, string][]},
    }),
  }
}

export const nextMessage: SimHttp['nextMessage'] = (_id) =>
  Promise.resolve({kind: 'end' as const})

export const cancel: SimHttp['cancel'] = (_id) => {}

export const pendingCount: SimHttp['pendingCount'] = () => 0
`,
}
