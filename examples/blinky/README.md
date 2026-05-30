# Blinky

The "hello world" of microcontrollers.

```sh
npm create mikro -- --template blinky
```

## Hardware

Drives GPIO 20. Wire an LED + resistor to that pin, or change the pin number to match your board's built-in LED.

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```
