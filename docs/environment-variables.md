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

```ts
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

**Set a variable:**

```sh
npx mikro env set API_URL https://api.example.com
```

**Set a secret** (prompts for the value, never displayed):

```sh
npx mikro env set API_KEY --secret
```

**List all variables:**

```sh
npx mikro env list
```

Secret values are masked in the output:

```
API_URL   https://api.example.com
API_KEY   ********
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
WIFI_SSID=MyNetwork
API_URL=https://api.example.com
```

#### Precedence

Auto-loaded in this order, with later files overriding earlier ones:

1. `.env`
2. `.env.<mode>`: where `<mode>` matches the `MIKRO_ENV` value the command sets (see [Built-in variables](#mikro-env) below). For example: `.env.development` for `mikro dev`, `.env.production` for `mikro deploy`, `.env.test` for `mikro test`, `.env.simulator` for any `mikro sim …` command.
3. `--env FILE`: extra file passed explicitly (additive)
4. `--secrets FILE`: extra file passed explicitly, entries marked as secrets

Auto-discovered files are silently skipped if missing. Explicit `--env` / `--secrets` paths error if the file doesn't exist.

::: warning .env files should never be committed
The `create-mikrojs` scaffold gitignores `.env*`. Commit `.env.example` instead to share the shape of the variables your project expects.
:::

#### Variable name limit

Names must be 15 characters or fewer. The CLI errors with the full list of offending names before deploy if any are too long. This is the [NVS key limit](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/storage/nvs_flash.html) on device.

#### Opting out

Pass `--no-env-file` to skip auto-discovery. Explicit `--env` / `--secrets` files still load:

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

```ts
import {env} from 'mikrojs/env'

if (env.get('MIKRO_ENV') === 'development') {
  // verbose logging, etc.
}
```

If you explicitly set `MIKRO_ENV` in your `.env` file, your value takes precedence over the default.

## Secrets vs. regular variables

The `--secret` flag describes the _intent_ of a value. It tells the CLI that the value is sensitive, so it prompts for the value instead of taking it as an argument and masks it in `env list` output. It does not change how or where the value is stored. All environment variables, secret or not, live in the same plaintext NVS storage and are equally available at runtime via [`mikrojs/env`](/api/env) and `import.meta.env`.

The difference:

|                           | Regular                   | Secret                       |
| ------------------------- | ------------------------- | ---------------------------- |
| Stored on device          | Yes                       | Yes                          |
| Available at runtime      | Yes                       | Yes                          |
| Shown in `mikro env list` | Value visible             | Masked (`********`)          |
| Set via CLI               | `mikro env set KEY value` | `mikro env set KEY --secret` |

A variable name must be unique. Setting a variable with `--secret` overwrites any existing non-secret variable with the same name, and vice versa.

## Simulator

`mikro sim dev`, `mikro sim deploy`, and `mikro sim test` auto-load `.env` and `.env.simulator` from the project root, with the same precedence rules as the device commands. Sim env vars persist in `.mikro/nvs.json` and can be inspected or edited with `mikro sim env list|get|set|delete`.
