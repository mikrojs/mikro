import type {Minifier, MinifyLevel} from '../../_exports/index.js'

export async function minifyJs(
  code: string,
  minifier: Minifier = 'esbuild',
  level: MinifyLevel = 'default',
  pureFuncs?: string[],
): Promise<string> {
  switch (minifier) {
    case 'esbuild':
      return minifyWithEsbuild(code, pureFuncs)
    case 'terser':
      return minifyWithTerser(code, level, pureFuncs)
    case 'swc':
      return minifyWithSwc(code, level, pureFuncs)
  }
}

async function minifyWithEsbuild(code: string, pureFuncs?: string[]): Promise<string> {
  const {transform} = await import('esbuild')
  const result = await transform(code, {
    minify: true,
    loader: 'js',
    ...(pureFuncs?.length ? {pure: pureFuncs} : undefined),
  })
  return result.code
}

// Dynamic import with variable to prevent TypeScript from resolving the module
// at type-check time. These are optional peer dependencies.
function importOptional(name: string): Promise<any> {
  return import(name)
}

async function minifyWithTerser(
  code: string,
  level: MinifyLevel,
  pureFuncs?: string[],
): Promise<string> {
  let terser: any
  try {
    terser = await importOptional('terser')
  } catch {
    throw new Error(
      `Minifier 'terser' selected but the 'terser' package is not installed. ` +
        `Install it with: npm install -D terser`,
    )
  }
  const result = await terser.minify(
    code,
    level === 'max'
      ? {
          module: true,
          ecma: 2020,
          compress: {
            ecma: 2020,
            module: true,
            passes: 3,
            toplevel: true,
            pure_getters: true,
            unsafe_arrows: true,
            unsafe_math: true,
            unsafe_methods: true,
            ...(pureFuncs?.length ? {pure_funcs: pureFuncs} : undefined),
          },
          mangle: {
            module: true,
            toplevel: true,
          },
        }
      : {module: true, ...(pureFuncs?.length ? {compress: {pure_funcs: pureFuncs}} : undefined)},
  )
  if (result.code === undefined) {
    throw new Error('terser produced no output')
  }
  return result.code
}

async function minifyWithSwc(
  code: string,
  level: MinifyLevel,
  pureFuncs?: string[],
): Promise<string> {
  let swc: any
  try {
    swc = await importOptional('@swc/core')
  } catch {
    throw new Error(
      `Minifier 'swc' selected but the '@swc/core' package is not installed. ` +
        `Install it with: npm install -D @swc/core`,
    )
  }
  const result = await swc.minify(
    code,
    level === 'max'
      ? {
          module: true,
          compress: {
            module: true,
            passes: 3,
            toplevel: true,
            pure_getters: true,
            unsafe_arrows: true,
            unsafe_math: true,
            unsafe_methods: true,
            ...(pureFuncs?.length ? {pure_funcs: pureFuncs} : undefined),
          },
          mangle: {
            toplevel: true,
          },
        }
      : {module: true, ...(pureFuncs?.length ? {compress: {pure_funcs: pureFuncs}} : undefined)},
  )
  return result.code
}
