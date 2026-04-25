export {
  deepSleep,
  disableWakeupSource,
  enableExt0Wakeup,
  enableExt1Wakeup,
  enableGpioWakeup,
  enableTimerWakeup,
  getWakeupCause,
  lightSleep,
} from 'native:sleep'

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
