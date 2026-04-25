/**
 * Persists the selected code-group tab (e.g. "npm", "pnpm", "yarn") to
 * localStorage and syncs the choice across all code groups on the page.
 *
 * VitePress code groups use radio inputs + `.active` class on block children.
 * We mirror that mechanism directly instead of simulating clicks.
 */

const STORAGE_KEY = 'mikrojs-pm'
const PM_LABELS = new Set(['npm', 'pnpm', 'yarn', 'bun'])

function getPreferred(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

function setPreferred(label: string) {
  try {
    localStorage.setItem(STORAGE_KEY, label)
  } catch {
    // ignore
  }
}

function activateTabInGroup(group: Element, label: string) {
  const inputs = group.querySelectorAll<HTMLInputElement>('input')
  const labels = group.querySelectorAll<HTMLLabelElement>('.tabs label')
  const blocks = group.querySelector('.blocks')
  if (!blocks) return

  for (let i = 0; i < labels.length; i++) {
    if (labels[i].textContent?.trim() === label) {
      // Check the radio input
      if (inputs[i]) inputs[i].checked = true
      // Toggle active class on blocks
      for (const child of Array.from(blocks.children)) {
        child.classList.remove('active')
      }
      if (blocks.children[i]) {
        blocks.children[i].classList.add('active')
      }
      return
    }
  }
}

function syncAll(label: string) {
  for (const group of document.querySelectorAll('.vp-code-group')) {
    activateTabInGroup(group, label)
  }
}

export function setupCodeGroupSync() {
  if (typeof window === 'undefined') return

  // Listen for tab changes and persist + sync
  window.addEventListener('click', (e) => {
    const input = (e.target as HTMLElement)?.closest?.(
      '.vp-code-group input',
    ) as HTMLInputElement | null
    if (!input) return

    const group = input.closest('.vp-code-group')
    if (!group) return

    const label = group.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)
    const text = label?.textContent?.trim()
    if (!text || !PM_LABELS.has(text)) return

    setPreferred(text)
    // Sync other code groups on the page
    requestAnimationFrame(() => syncAll(text))
  })
}

export function restorePreferred() {
  const preferred = getPreferred()
  if (preferred) {
    requestAnimationFrame(() => syncAll(preferred))
  }
}
