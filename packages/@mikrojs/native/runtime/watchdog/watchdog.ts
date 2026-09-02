import {feed} from 'native:mikro/watchdog'

import type {Watchdog} from './types.js'

export type {Watchdog} from './types.js'

export const watchdog: Watchdog = {feed}
