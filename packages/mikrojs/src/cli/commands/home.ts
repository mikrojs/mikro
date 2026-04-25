/* eslint-disable no-console */
import {command, constant, message} from '@optique/core'
import {object} from '@optique/core/constructs'
import open from 'open'

const HOME_URL = 'https://mikrojs.dev'

export const args = command(
  'home',
  object({
    action: constant('home'),
  }),
  {description: message`Open the mikrojs website in your browser`},
)

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
