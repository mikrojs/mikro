/** Chips the firmware supports (e.g. "esp32c6"): it has settings for each. */
export const CHIPS = ['esp32', 'esp32c3', 'esp32c5', 'esp32c6', 'esp32s3'] as const
export type Chip = (typeof CHIPS)[number]

/** CHIPS as a plain list, to check a string against. */
export const chips: readonly string[] = [...CHIPS]
