import {defineConfig} from 'taze'

export default defineConfig({
  // ignore paths for looking for package.json in monorepo
  // Submodules are listed explicitly: ignoreOtherWorkspaces only prunes
  // package.json discovery, not the workflow and .nvmrc manifests.
  ignorePaths: [
    '**/node_modules/**',
    '**/test/**',
    'packages/@mikrojs/quickjs/deps/quickjs/**',
    'packages/@mikrojs/native/deps/nanocbor/**',
  ],
  // ignore package.json that in other workspaces (with their own .git,pnpm-workspace.yaml,etc.)
  ignoreOtherWorkspaces: true,

  packageMode: {
    node: 'minor',
    '@types/node': 'minor',
  },
})
