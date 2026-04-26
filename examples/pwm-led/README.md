# PWM LED

Fades an LED in and out using PWM. The "breathing" effect.

```sh
npm create mikrojs my-pwm-led --template pwm-led
```

## Hardware

LED + resistor on GPIO 20. Change `LED_PIN` in `main.ts` for your board.

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```
