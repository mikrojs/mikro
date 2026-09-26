/* eslint-disable no-console */
import open from 'open'

const HOME_URL = 'https://mikrojs.dev'

export async function run(): Promise<void> {
  console.error(`Opening ${HOME_URL}…`)
  try {
    await open(HOME_URL)
  } catch (err) {
    console.error(`Failed to open browser: ${err instanceof Error ? err.message : String(err)}`)
    console.error(`Open manually: ${HOME_URL}`)
    process.exit(1)
  }
}
