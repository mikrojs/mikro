export const componentDir: string
export const configDir: string
export const defaultAppDir: string
export const projectCmakePath: string
export const chips: string[]

export function prebuiltFirmwareDir(chip: string): string
export function hasPrebuiltFirmware(chip: string): boolean
export function prebuiltFirmwareName(chip: string): string | undefined
