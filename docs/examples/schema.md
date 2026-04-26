---
title: Schema
description: Runtime data validation with typed schemas
---

# Schema

Validates JSON data received over HTTP using typed schemas. This is a typical use case: data arrives from an external API as `unknown`, and you need to verify its shape before using it. See the [schema API reference](/api/schema) for caveats, when to use, and the full type surface.

## Hardware

- Any ESP32 board with WiFi
- USB-C cable

## Code

```ts
import * as s from 'mikrojs/schema'

// Define a schema for the API response
const WeatherResponse = s.object({
  temperature: s.number(),
  humidity: s.number(),
  description: s.optional(s.string()),
})

// Simulate data arriving from an HTTP API
const raw: unknown = JSON.parse('{"temperature": 22.5, "humidity": 45.2}')

const result = s.parse(WeatherResponse, raw)
if (result.ok) {
  console.log(`Temperature: ${result.value.temperature}`)
  console.log(`Humidity: ${result.value.humidity}`)
} else {
  console.error(`Invalid response: ${result.error.message} at ${result.error.path}`)
}
```

## Walkthrough

1. **Define a schema.** `s.object({...})` describes the expected shape. Each field gets a type validator like `s.number()` or `s.string()`.

2. **Parse untrusted data.** `s.parse()` checks the data against the schema and returns a [`Result`](/api/result). On success, `result.value` is fully typed. On failure, `result.error` tells you what went wrong and where.

3. **No exceptions.** Validation never throws. You always get a [`Result`](/api/result) to handle both cases explicitly.

## Create project

::: code-group

```sh [pnpm]
pnpm create mikrojs my-schema --template schema
```

```sh [npm]
npm create mikrojs -- my-schema --template schema
```

```sh [yarn]
yarn create mikrojs my-schema --template schema
```

```sh [bun]
bun create mikrojs my-schema --template schema
```

:::

## Run it

```sh
cd my-schema
```

::: code-group

```sh [pnpm]
pnpm install
pnpm mikro dev
```

```sh [npm]
npm install
npx mikro dev
```

```sh [yarn]
yarn install
yarn mikro dev
```

```sh [bun]
bun install
bunx mikro dev
```

:::

You should see the valid readings and commands printed, and clear error messages for the invalid ones.

[View source on GitHub](https://github.com/mikrojs/mikrojs/tree/main/examples/schema)
