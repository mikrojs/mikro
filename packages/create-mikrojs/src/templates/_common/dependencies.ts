import type {PackageJson} from 'type-fest'

export const dependencies = {
  mikrojs: 'latest',
} satisfies PackageJson['dependencies']

export const devDependencies = {
  typescript: '^6.0.0-beta',
} satisfies PackageJson['devDependencies']
