import {watch} from 'node:fs'

import {Subject} from 'rxjs'

export interface WatchEvent {
  type: 'change' | 'rename'
  filename: string | null
}

export function createWatcher(
  dir: string,
  debounceMs = 200,
): {
  changes$: Subject<WatchEvent[]>
  close: () => void
} {
  const changes$ = new Subject<WatchEvent[]>()
  let pending: WatchEvent[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const watcher = watch(dir, {recursive: true}, (eventType, filename) => {
    // Ignore hidden files (covers .mikro/, .git/, etc)
    if (filename && filename.startsWith('.')) {
      return
    }
    // Ignore node_modules
    if (filename && filename.includes('node_modules')) {
      return
    }

    pending.push({type: eventType as 'change' | 'rename', filename})

    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      const batch = pending
      pending = []
      timer = null
      changes$.next(batch)
    }, debounceMs)
  })

  const close = () => {
    if (timer) clearTimeout(timer)
    watcher.close()
    changes$.complete()
  }

  return {changes$, close}
}
