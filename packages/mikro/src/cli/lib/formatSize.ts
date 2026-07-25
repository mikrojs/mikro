/** A byte count for humans, in binary units (1 KB = 1024 B). Binary and not SI
 *  because everything a size is compared against here is binary: flash and
 *  partition sizes, heap figures, the numbers on the datasheet. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}
