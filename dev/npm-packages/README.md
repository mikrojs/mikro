# npm-packages

Dev fixture that loads npm packages on the device. The build resolves package
imports on the host and rewrites them to relative paths. The unit tests check
the paths. This fixture checks that the device, or the simulator, loads the
files.

`test/packages.test.ts` asserts what loads. `app/main.ts` imports the same
things and prints them, so that a deploy and the REPL can be checked too. Both
import:

- `pretty-ms` 9 from the registry, which has a dependency of its own (`parse-ms`).
- `@repo/uptime`, a workspace package linked from `dev/npm-packages-uptime`. Its
  `package.json` uses a condition object, a wildcard export and an `imports`
  entry. The device's resolver reads none of those. It also imports its own
  `package.json`.
- `pretty-ms` 8, through `@repo/uptime`, so that two versions deploy.
- `pretty-ms` by a name computed at runtime. The build leaves that import as
  written, so it goes through the device's resolver and the `package.json` the
  build generates. The REPL imports packages the same way.

## Run the tests

```sh
pnpm install
pnpm test:sim   # in the simulator
pnpm test       # on a connected device
```

## Run the app

```sh
pnpm dev:sim    # in the simulator
pnpm dev        # on a connected device
```

The app prints these lines, then an `up …` line every 5 seconds:

```
hello from @repo/uptime 1.2.3
pretty-ms by name is the module imported above: true
pretty-ms 8 and 9 are two modules: true
up 0ms (pretty-ms 9), 0ms (pretty-ms 8), 0ms (short)
```

The first word is `hello` or `hei`. The app picks `app/lang/en.ts` or
`app/lang/no.ts` with an `import()` between two literals, and both files deploy.

While the app runs, import a package by name in the REPL:

```js
await import('pretty-ms') // resolves: one copy has that name
await import('@repo/uptime/formats/short') // resolves: the app imports that subpath
await import('pretty-ms@8.0.0') // fails: a versioned directory has no package.json
await import('parse-ms') // fails: both copies are versioned
```

## Check the layout

```sh
pnpm build
find build -type f | sort
```

`pnpm build` builds the app without bytecode and minification, so the files are
readable. The paths below are relative to `build/app/`. Make sure of these:

- The app imports `pretty-ms` 9, so that copy deploys at
  `node_modules/pretty-ms/`, with a generated `package.json`.
- `pretty-ms` 8 deploys at `node_modules/pretty-ms@8.<x>.<y>/`, without a
  `package.json`.
- No file imports `parse-ms` by name, so both copies deploy at
  `node_modules/parse-ms@<version>/`.
- `node_modules/@repo/uptime/_package.json` is the package's own
  `package.json`. `node_modules/@repo/uptime/package.json` is the generated one.
- Every import of a package in `main.js` is a relative path, except
  `mikro/sleep`.
- The build prints a notice that `pretty-ms` and `parse-ms` deploy twice.

## Deploy over an older layout

Before imports were rewritten, packages deployed nested
(`node_modules/a/node_modules/b`). To check the move from that layout:

1. Check out a commit from before the rewrite, and copy this directory into it.
2. Run `pnpm install`, then `pnpm dev` with the device connected.
3. Go back to this commit, and run `pnpm dev` again on the same device.

The app must print its lines both times. After the second run, list the device's files
and check whether the old nested directories are still there.
