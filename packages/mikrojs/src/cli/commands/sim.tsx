import {command, constant} from '@optique/core'
import {object as objectConstruct, or as orConstruct} from '@optique/core/constructs'
import type {InferValue} from '@optique/core/parser'
import {type ComponentType, createElement} from 'react'

import * as cleanSub from './sim/clean.js'
import * as deploySub from './sim/deploy.js'
import * as devSub from './sim/dev.js'
import * as envSub from './sim/env.js'
import * as profileSub from './sim/profile.js'
import * as replSub from './sim/repl.js'
import * as resetSub from './sim/reset.js'
import * as scaffoldSub from './sim/scaffold.js'
import * as testSub from './sim/test.js'

export const args = command(
  'sim',
  objectConstruct({
    action: constant('sim'),
    sub: orConstruct(
      devSub.args,
      deploySub.args,
      replSub.args,
      testSub.args,
      envSub.args,
      cleanSub.args,
      resetSub.args,
      profileSub.args,
      scaffoldSub.args,
    ),
  }),
)

type Args = InferValue<typeof args>

export async function run(config: Args): Promise<void> {
  const sub = config.sub
  switch (sub.subcommand) {
    case 'dev':
      await devSub.run(sub)
      break
    case 'deploy':
      await deploySub.run(sub)
      break
    case 'repl':
      await replSub.run(sub)
      break
    case 'test':
      await testSub.run(sub)
      break
    case 'env':
      await envSub.run(sub)
      break
    case 'clean':
      cleanSub.run()
      break
    case 'reset':
      await resetSub.run(sub)
      break
    case 'profile':
      await profileSub.run(sub)
      break
    case 'scaffold':
      scaffoldSub.run(sub)
      break
  }
}

/**
 * Map subcommand → React component for the dispatcher in cli.ts.
 * Subcommands without an Ink component (one-shots) return null.
 */
export function getInkComponent(
  sub: Args['sub'],
): {Component: ComponentType<{args: any}>; props: any} | null {
  switch (sub.subcommand) {
    case 'dev':
      return {Component: devSub.default, props: {args: sub}}
    case 'repl':
      return {Component: replSub.default, props: {args: sub}}
    default:
      return null
  }
}

export default function SimComponent(props: {args: Args}) {
  const inkUi = getInkComponent(props.args.sub)
  if (!inkUi) return null
  return createElement(inkUi.Component, inkUi.props)
}
