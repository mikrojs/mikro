import {defineConfig} from 'taze'

export default defineConfig({
  // ignore paths for looking for package.json in monorepo
  ignorePaths: ['**/node_modules/**', '**/test/**'],
  // ignore package.json that in other workspaces (with their own .git,pnpm-workspace.yaml,etc.)
  ignoreOtherWorkspaces: true,

  packageMode: {
    node: 'minor',
    typescript: 'minor', // waiting for 7.1, need API
    '@types/node': 'minor',
  },
})
