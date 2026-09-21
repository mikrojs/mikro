import {dirname, join, relative} from 'node:path'

import {memoryFs} from './memoryFs.js'

export type Package = {files: Record<string, string>; deps?: Record<string, string>; pjson?: object}

export const pkg = (name: string, pjson: object = {}) =>
  JSON.stringify({name, type: 'module', exports: {'./*': './*'}, ...pjson})

/** A pnpm install in memory: every package sits in the store at
 *  `<name>@<version>`, with its dependencies linked next to it. The app's
 *  node_modules links into the store, which is inside the app (a standalone
 *  project) or above it (a workspace). Keys of `packages` are `<name>@<version>`. */
export function pnpmInstall(
  storeIn: 'app' | 'workspace',
  packages: Record<string, Package>,
  appDeps: Record<string, string>,
  input: string,
) {
  const app = '/ws/app'
  const store = join(storeIn === 'app' ? app : '/ws', 'node_modules/.pnpm')
  const files: Record<string, string> = {}
  const links: Record<string, string> = {}
  // pnpm names a scoped package's store directory `@scope+name@version`.
  const inStore = (name: string, version: string) =>
    join(store, `${name.replace('/', '+')}@${version}`, 'node_modules')
  for (const [id, {files: sources, deps = {}, pjson = {}}] of Object.entries(packages)) {
    const name = id.slice(0, id.lastIndexOf('@'))
    const version = id.slice(name.length + 1)
    const dir = inStore(name, version)
    files[join(dir, name, 'package.json')] = pkg(name, {version, ...pjson})
    for (const [file, contents] of Object.entries(sources)) files[join(dir, name, file)] = contents
    for (const [dep, depVersion] of Object.entries(deps)) {
      links[join(dir, dep)] = relative(dirname(join(dir, dep)), join(inStore(dep, depVersion), dep))
    }
  }
  for (const [dep, version] of Object.entries(appDeps)) {
    links[join(app, 'node_modules', dep)] = join(inStore(dep, version), dep)
  }
  files[join(app, 'package.json')] = pkg('app')
  files[join(app, 'input.js')] = input
  return {app, store, files, links, fs: () => memoryFs(files, links)}
}
