import type {PackageJson} from 'type-fest'

export const dependencies = {
  mikro: 'latest',
} satisfies PackageJson['dependencies']

export const devDependencies = {
  prettier: '^3.4.0',
  typescript: '^6.0.3',
} satisfies PackageJson['devDependencies']

export const eslintDevDependencies = {
  '@eslint/js': '^10.0.1',
  eslint: '^10.2.1',
  'typescript-eslint': '^8.59.0',
} satisfies PackageJson['devDependencies']
