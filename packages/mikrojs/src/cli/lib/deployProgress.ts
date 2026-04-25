import type {DeployEvent} from './session.js'

/**
 * Format a DeployEvent as a single-line progress string, or null if the
 * event should not produce a log line (e.g. `checking` is emitted per file
 * and is too chatty for a typical TTY log).
 */
export function formatDeployEvent(event: DeployEvent): string | null {
  switch (event.type) {
    case 'connecting':
      return 'Waiting for device…'
    case 'checking':
      return null
    case 'uploading':
      return `Uploading [${event.index + 1}/${event.total}] ${event.file}`
    case 'env_changed': {
      const parts: string[] = []
      for (const k of event.changed) parts.push(`+${k}`)
      for (const k of event.removed) parts.push(`-${k}`)
      return `Env updated: ${parts.join(' ')}`
    }
    case 'restarting':
      return 'Restarting device…'
    case 'complete':
      // Keep this command-neutral: a "press Ctrl+R" hint only makes sense
      // for the interactive dev REPL — `mikro test`, `mikro deploy`, and
      // `mikro sim deploy` use this same formatter. Dev can render its own
      // hint via the REPL UI if it wants.
      return event.deployed ? null : 'No changes.'
  }
}
