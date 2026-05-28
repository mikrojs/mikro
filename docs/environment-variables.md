---
title: Environment Variables
description: Configure your app with environment variables and secrets
---

# Environment Variables

Environment variables let you configure your app without hardcoding values. On device, they're stored in [NVS](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/storage/nvs_flash.html) and persist across reboots.

::: warning Storage is not encrypted
Environment variables are stored as plaintext in NVS flash. Anyone with physical access to the device can dump the flash and read them.
:::

## Reading environment variables

The `mikrojs/env` module provides explicit methods for reading environment variables:

```ts twoslash
import {env} from 'mikrojs/env'

// Required: panics if not set (catches typos and missing config early)
const ssid = env.require('WIFI_SSID')

// Optional: returns undefined if not set
const debug = env.get('DEBUG')

// Check if a variable is set
if (env.has('API_KEY')) {
  // ...
}
```

Environment variables are also available on `import.meta.env` as a standard frozen object. Accessing a missing key returns `undefined`:

```ts
const ssid = import.meta.env.WIFI_SSID // string | undefined
```

## Setting environment variables

### With `mikro env`

The `mikro env` command reads and writes environment variables directly on the connected device.

**Set a secret** (prompts for the value, never echoes to your terminal):

```sh
npx mikro env set API_KEY
Enter value for API_KEY: ********
```

**Set a non-secret** (visible in `env list`, safe to pass on the command line):

```sh
npx mikro env set API_URL https://api.example.com --no-secret
```

Passing a `VALUE` without `--no-secret` errors. This keeps secrets out of shell history and `ps` output.

**List all variables:**

```sh
npx mikro env list
```

Secret values are masked in the output; values marked `# @no-secret` in a `.env` file remain visible:

```
WIFI_SSID  MyNetwork
API_URL    ********
API_KEY    ********
```

**Delete a variable:**

```sh
npx mikro env delete API_URL
```

::: tip
Variable names can be up to 15 characters (NVS key limit). Use short, descriptive names like `WIFI_SSID`, `API_KEY`, `MQTT_HOST`.
:::

### With `.env` files

`mikro dev`, `mikro deploy`, `mikro test` (and their `mikro sim …` counterparts) automatically load `.env` files from the project root. Files use standard dotenv format:

```sh
# .env
API_URL=https://api.example.com
API_KEY=sk-…

# Mark a value visible in `mikro env list` (e.g. for debugging):
# @no-secret
WIFI_SSID=MyNetwork
```

Every entry is treated as a secret by default. Add a `# @no-secret` comment line directly above an entry to mark just that one variable as visible in `mikro env list`. A blank line breaks the association.

#### Precedence

Auto-loaded in this order, with later files overriding earlier ones:

1. `.env`
2. `.env.<mode>`: where `<mode>` matches the `MIKRO_ENV` value the command sets (see [Built-in variables](#mikro-env) below). For example: `.env.development` for `mikro dev`, `.env.production` for `mikro deploy`, `.env.test` for `mikro test`, `.env.simulator` for any `mikro sim …` command.
3. `--env FILE`: extra file passed explicitly (additive)

Auto-discovered files are silently skipped if missing. An explicit `--env` path errors if the file doesn't exist.

::: warning .env files should never be committed
The `create-mikrojs` scaffold gitignores `.env*`. Commit `.env.example` instead to share the shape of the variables your project expects.
:::

#### Variable name limit

Names must be 15 characters or fewer. The CLI errors with the full list of offending names before deploy if any are too long. This is the [NVS key limit](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/storage/nvs_flash.html) on device.

#### Opting out

Pass `--no-env-file` to skip auto-discovery. An explicit `--env` file still loads:

```sh
# Use only what's in the shell environment (CI scenarios)
npx mikro deploy --no-env-file

# Skip auto-discovery, but still load this one file
npx mikro deploy --no-env-file --env=ci.env
```

## Built-in variables

### `MIKRO_ENV`

The CLI automatically sets `MIKRO_ENV` based on the command being run:

| Command            | `MIKRO_ENV`   |
| ------------------ | ------------- |
| `mikro dev`        | `development` |
| `mikro deploy`     | `production`  |
| `mikro test`       | `test`        |
| `mikro sim dev`    | `simulator`   |
| `mikro sim deploy` | `simulator`   |
| `mikro sim test`   | `simulator`   |

You can use this to change behavior based on the current environment:

```ts twoslash
import {env} from 'mikrojs/env'

if (env.get('MIKRO_ENV') === 'development') {
  // verbose logging, etc.
}
```

If you explicitly set `MIKRO_ENV` in your `.env` file, your value takes precedence over the default.

## Secrets vs. regular variables

The `secret` flag describes the _intent_ of a value. It controls whether the value is shown in `mikro env list`. It does not change how or where the value is stored. All environment variables, secret or not, live in the same plaintext NVS storage and are equally available at runtime via [`mikrojs/env`](/api/env) and `import.meta.env`. See [Setting environment variables](#setting-environment-variables) above for how to mark values as secret or non-secret.

## Simulator

`mikro sim dev`, `mikro sim deploy`, and `mikro sim test` auto-load `.env` and `.env.simulator` from the project root, with the same precedence rules as the device commands. Sim env vars persist in `.mikro/nvs.json` and can be inspected or edited with `mikro sim env list|get|set|delete`.
