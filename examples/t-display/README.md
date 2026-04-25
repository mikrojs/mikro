# T-Display

Bouncing DVD logo game on a LilyGo T-Display's ST7789 LCD. The logo changes color on each bounce; score a point when it hits a corner. Buttons nudge the speed.

```sh
npm create mikrojs my-t-display --template t-display
```

## Hardware

- LilyGo T-Display (ESP32 with built-in 1.14" ST7789 LCD and two buttons)
- Display and pin config from `@mikrojs/lilygo/t-display`

## Controls

- **BTN1** - nudge horizontal speed
- **BTN2** - nudge vertical speed

## Run

```sh
npx mikro dev       # develop on connected device
npx mikro deploy    # build and deploy to device
```
