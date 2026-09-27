/**
 * `args` with a bare `--board` of `mikro fw build` or `mikro fw pack`, or a
 * bare `--image` of `mikro fw build` (last, or before another option), given
 * as `--board=` and `--image=`, which ask for one (pickBoard, pickImage): an
 * option's value can't be left out, and a bare `--board` before `--image`
 * would take `--image` for the board.
 */
export function bareOptions(args: readonly string[]): string[] {
  const fw = args.indexOf('fw')
  const sub = fw === -1 ? undefined : args[fw + 1]
  if (sub !== 'build' && sub !== 'pack') return [...args]
  const bare = sub === 'build' ? ['--board', '--image'] : ['--board']
  return args.map((arg, i) =>
    i > fw + 1 && bare.includes(arg) && (args[i + 1] === undefined || args[i + 1]!.startsWith('-'))
      ? `${arg}=`
      : arg,
  )
}
