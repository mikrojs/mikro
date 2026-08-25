// `ota.config()`, backed by the C reader (src/mik_ota_config.cpp).
//
// Its own module rather than part of `mikro/ota`: an app that only reads config
// should not also pay for the policy surface, which most apps never touch.

import {config as nativeConfig} from 'native:mikro/ota_client'

import type {RegisteredConfig} from './types.js'

/**
 * The effective config for the running build: the manifest defaults with the
 * stored document spread over them, top level only. Always an object, and a
 * fresh one on every call.
 *
 * Throws when there is nothing to serve: a build with no readable manifest and
 * no stored document, which is a build that never went through `mikro deploy`.
 */
export const config = nativeConfig as <T = RegisteredConfig>() => T
