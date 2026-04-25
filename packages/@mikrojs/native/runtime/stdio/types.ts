export interface StdIn {
  addListener(event: 'data', callback: (chunk: Uint8Array) => any): void

  removeListener(event: 'data', callback: (chunk: Uint8Array) => any): void

  read(): Uint8Array | undefined

  setRawMode?: (rawMode: boolean) => void
}

export interface StdOut {
  isTTY: boolean

  write(output: string | Uint8Array): boolean

  getWindowSize?: () => [width: number, height: number]

  flush(): void
}

export declare const stdin: StdIn
export declare const stdout: StdOut
