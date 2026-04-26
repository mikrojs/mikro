import type {PackageJson} from 'type-fest'

export const dependencies = {
  mikrojs: 'latest',
} satisfies PackageJson['dependencies']

export const devDependencies = {
  typescript: '^6.0.0-beta',
} satisfies PackageJson['devDependencies']

export const eslintDevDependencies = {
  '@eslint/js': '^10.0.1',
  eslint: '^10.2.1',
  'typescript-eslint': '^8.58.0',
} satisfies PackageJson['devDependencies']
