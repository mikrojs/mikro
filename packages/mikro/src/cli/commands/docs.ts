/* eslint-disable no-console */
import open from 'open'

const DOCS_URL = 'https://mikrojs.dev/docs'

export async function run(): Promise<void> {
  console.error(`Opening ${DOCS_URL}…`)
  try {
    await open(DOCS_URL)
  } catch (err) {
    console.error(`Failed to open browser: ${err instanceof Error ? err.message : String(err)}`)
    console.error(`Open manually: ${DOCS_URL}`)
    process.exit(1)
  }
}
