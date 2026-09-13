import {DigitalIn, DigitalOut} from 'mikro/gpio'
import {debounceTime, distinctUntilChanged} from 'mikro/observable/operators'

// GPIO 9 is the BOOT button and GPIO 15 the built-in LED on XIAO ESP32C6.
// Both are active-low: the button reads 0 while pressed, and the LED lights
// when driven to 0. Replace with your board's GPIO numbers.
const button = DigitalIn(9, {pull: 'up'}).orPanic('Failed to configure button')
const led = DigitalOut(15, {initial: 1}).orPanic('Failed to configure LED')

// Contacts bounce for a few milliseconds when pressed or released. Wait for
// the level to settle, then drop repeats of the level already seen.
button.onChange.pipe(debounceTime(20), distinctUntilChanged()).subscribe((level) => {
  console.log(level === 0 ? 'pressed' : 'released')
  led.write(level)
})
