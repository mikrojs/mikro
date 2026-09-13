/* eslint-disable no-console */
// Simulator stub for gpio
// Runs inside the mikrojs runtime (QuickJS), not Node.js. Node built-ins are not available.
import {Observable} from 'mikro/observable'
import {err, ok} from 'mikro/result'
import type {SimGpio} from 'mikro/sim'

// Unlike the device, a handle dropped without end() keeps its GPIO claimed here:
// the simulator has no finalizer to release it.
const owners = new Map<number, string>()
// Maps a GPIO to a setter for its DigitalIn level. The setter emits onChange
// when the level changes.
const inputs = new Map<number, (level: 0 | 1) => void>()

// To simulate a button on GPIO 9, flip its level every second:
// let level: 0 | 1 = 1
// setInterval(() => inputs.get(9)?.((level = level ? 0 : 1)), 1000)

function claim(gpio: number, owner: string) {
  const holder = owners.get(gpio)
  if (holder === undefined) {
    owners.set(gpio, owner)
    return undefined
  }
  return err({
    name: 'GpioInUse' as const,
    owner: holder,
    message: 'GPIO ' + gpio + ' is already in use by ' + holder,
  })
}

// Reports use of a handle after end() once, as the device does.
function warnAfterEnd(gpio: number) {
  let warned = false
  return (call: string) => {
    if (warned) return
    warned = true
    console.error('GPIO ' + gpio + ': ' + call + ' after end(); the handle no longer owns the pin')
  }
}

export const DigitalOut: SimGpio['DigitalOut'] = (gpio) => {
  const inUse = claim(gpio, 'DigitalOut')
  if (inUse) return inUse
  let released = false
  const warn = warnAfterEnd(gpio)
  return ok({
    gpio,
    write(_level: 0 | 1) {
      if (released) warn('write() ignored')
    },
    end() {
      if (released) return
      released = true
      owners.delete(gpio)
    },
  })
}

export const DigitalIn: SimGpio['DigitalIn'] = (gpio, options = {}) => {
  const inUse = claim(gpio, 'DigitalIn')
  if (inUse) return inUse
  let released = false
  // Nothing drives the pad in the simulator, so it rests at its pull level.
  let level: 0 | 1 = options.pull === 'up' ? 1 : 0
  const {observable, next, complete} = Observable.withEmitters<0 | 1>()
  inputs.set(gpio, (value) => {
    if (released || value === level) return
    level = value
    next(value)
  })
  const warn = warnAfterEnd(gpio)
  return ok({
    gpio,
    read() {
      if (released) warn('read()')
      return level
    },
    onChange: observable,
    end() {
      if (released) return
      released = true
      inputs.delete(gpio)
      owners.delete(gpio)
      complete()
    },
  })
}

export const AnalogIn: SimGpio['AnalogIn'] = (gpio, _options = {}) => {
  const inUse = claim(gpio, 'AnalogIn')
  if (inUse) return inUse
  let released = false
  const warn = warnAfterEnd(gpio)
  return ok({
    gpio,
    read() {
      if (released) warn('read()')
      return ok(Math.floor(Math.random() * 4096))
    },
    readMillivolts() {
      if (released) warn('readMillivolts()')
      return ok(Math.floor(Math.random() * 2500))
    },
    end() {
      if (released) return
      released = true
      owners.delete(gpio)
    },
  })
}
