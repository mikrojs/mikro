import type {PackageJson} from 'type-fest'

export function packageJson(
  name: string,
  {
    devDependencies,
    dependencies,
    typescript,
  }: {
    dependencies?: PackageJson['devDependencies']
    devDependencies?: PackageJson['dependencies']
    /** Include the tsc predeploy hook. */
    typescript?: boolean
  } = {},
) {
  return {
    name,
    version: '0.0.0',
    private: true,
    type: 'module',
    main: './app/main.ts',
    ...(typescript
      ? {
          scripts: {
            lint: 'eslint .',
            typecheck: 'tsc --noEmit --pretty',
          },
        }
      : {}),
    dependencies: dependencies as {},
    devDependencies: devDependencies as {},
    ...(typescript
      ? {
          mikrojs: {
            predeploy: ['tsc --noEmit --pretty'],
          },
        }
      : {}),
  } satisfies PackageJson
}
