---
title: env
description: Read environment variables with explicit required/optional handling
---

# env

```ts twoslash
import {env} from 'mikrojs/env'
```

Read environment variables stored in NVS on the device. Provides explicit methods for required vs. optional access, replacing direct `import.meta.env` property access.

::: warning Storage is not encrypted
NVS values are plaintext; anyone with physical access can dump them. See [Environment Variables](/environment-variables) for the full picture.
:::

## env.require(key)

```ts
env.require(key: string): string
```

Get a required environment variable. Panics with a clear error message if the variable is not set.

```ts twoslash
// @noErrors
import {env} from 'mikrojs/env'
// ---cut---
const ssid = env.require('WIFI_SSID')
// TypeError: Required environment variable "WIFI_SSID" is not set
```

Use this for variables your app cannot function without (WiFi credentials, API keys, etc.).

## env.get(key)

```ts
env.get(key: string): string | undefined
```

Get an optional environment variable. Returns `undefined` if not set.

```ts twoslash
// @noErrors
import {env} from 'mikrojs/env'
// ---cut---
const debug = env.get('DEBUG')
if (debug) {
  console.log('Debug mode enabled')
}
```

## env.has(key)

```ts
env.has(key: string): boolean
```

Check whether an environment variable is set.

```ts twoslash
// @noErrors
import {env} from 'mikrojs/env'
// ---cut---
if (env.has('LOG_LEVEL')) {
  // configure logging
}
```

## Setting environment variables

See the [Environment Variables](/environment-variables) guide for how to set variables via the CLI, `.env` files, and secrets.
