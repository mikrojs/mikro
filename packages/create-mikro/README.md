# create-mikro

Scaffolding tool for new Mikro.js projects.

```sh
npm create mikro my-project
```

## Templates

| Template            | Description                 |
| ------------------- | --------------------------- |
| `blank`             | Empty starter project       |
| `blinky`            | Blink an LED                |
| `pwm-led`           | PWM LED fading              |
| `neopixel`          | RGB LED strip               |
| `wifi-fetch`        | WiFi + HTTP request         |
| `wifi-access-point` | WiFi hotspot                |
| `sntp`              | NTP time sync               |
| `rtc-counter`       | RTC counter with deep sleep |

## Usage

```sh
# Interactive (prompts for template)
npm create mikro my-project

# With template
npm create mikro -- my-project --template blinky

# With pnpm
pnpm create mikro my-project --template blinky
```
