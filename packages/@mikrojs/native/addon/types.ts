export interface MikroRuntimeOptions {
  memLimit?: number
  stackSize?: number
  fsBasePath?: string
  fsRoot?: string
  fsLimit?: number
  fsReadMax?: number
  env?: Record<string, string>
  /** Virtual module sources to register, keyed by module name (e.g. 'native:pin'). */
  modules?: Record<string, string>
}

export interface HostMessage {
  type: string
  data: string
}

export interface ProfileEntry {
  name: string
  deltaBytes: number
  order: number
}

export interface NativeMikroRuntime {
  evalModule(filename: string, isMain?: boolean): void
  evalModuleContent(filename: string, content: string): void
  evalScript(code: string): string | undefined
  loop(): Promise<void>
  loopOnce(): number
  stop(): void
  dispose(): void
  registerModuleSource(name: string, source: string): void
  drainMessages(): HostMessage[]
  postMessage(type: string, data: string): void
  setPreprocessor(fn: (filename: string, source: string) => string | undefined): void
  setRpcHandler(handler: (method: string, argsJson: string) => string | Promise<string>): void
  enableProfiling(): void
  getProfile(): ProfileEntry[]
  getProfileBaseline(): number
}

export interface NativeBindings {
  MikroRuntime: new (options?: MikroRuntimeOptions) => NativeMikroRuntime
  jsonToBjson(json: string): Buffer
  compileBytecode(source: string, moduleName: string, externals?: string[]): Buffer
}
