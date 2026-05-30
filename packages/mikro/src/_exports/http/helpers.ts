// Transport-agnostic HTTP helpers. Import from here when implementing a
// custom transport (e.g. an LTE modem) so the native-backed `request` and
// its `native:http` dependency aren't retained on device.

export type {Request, RequestOptions, Response} from '@mikrojs/native/runtime/http/helpers'
export {
  BodyConsumedError,
  makeResponse,
  prepareBody,
  RequestError,
} from '@mikrojs/native/runtime/http/helpers'
