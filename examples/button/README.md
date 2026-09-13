# Button

Lights an LED while a button is held, using `DigitalIn.onChange` with a debounce.

## Hardware

Reads the button on GPIO 9 and drives the LED on GPIO 15, both active-low (the BOOT button and user LED on a XIAO ESP32C6), so a press reads 0 and writing 0 lights the LED. Change the GPIO numbers to match your board.

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```
