import type {DuplicatePackage} from '@mikrojs/analyze-imports'

/** Notice for the packages a build deploys more than once, or undefined when
 * there are none. One line per copy: its deploy path and, when known, version. */
export function formatDuplicatePackagesNotice(duplicates: DuplicatePackage[]): string | undefined {
  if (duplicates.length === 0) return undefined
  const [first] = duplicates
  const subject =
    duplicates.length === 1
      ? `${first!.copies.length} copies of ${first!.name}`
      : `more than one copy of ${duplicates.length} packages`
  const copies = duplicates.flatMap((duplicate) => duplicate.copies)
  return [
    `This app deploys ${subject}. The device loads each copy as a separate module:`,
    ...copies.map(({path, version}) =>
      version === undefined ? `  ${path}` : `  ${path} (${version})`,
    ),
  ].join('\n')
}
