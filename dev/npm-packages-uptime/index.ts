// An older major than the app's, so two copies of pretty-ms deploy.
import prettyMs from 'pretty-ms'

import {now} from '#clock'

import meta from './package.json' with {type: 'json'}

export const version: string = meta.version

// For the test that the app's pretty-ms is a different module.
export {prettyMs}

export function uptime(): string {
  return prettyMs(now())
}
