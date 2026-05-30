import type {PackageJson} from 'type-fest'

export function packageJson(
  name: string,
  {
    devDependencies,
    dependencies,
  }: {
    dependencies?: PackageJson['devDependencies']
    devDependencies?: PackageJson['dependencies']
  } = {},
) {
  return {
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: './app/main.ts',
    scripts: {
      format: 'prettier --write .',
      'format:check': 'prettier --check .',
      lint: 'eslint .',
      typecheck: 'tsc --noEmit --pretty',
    },
    dependencies: dependencies as {},
    devDependencies: devDependencies as {},
    mikro: {
      predeploy: ['tsc --noEmit --pretty'],
    },
  } satisfies PackageJson
}
