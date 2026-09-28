# create-mikro

Scaffolding tool for new Mikro.js projects.

```sh
npm create mikro
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
npm create mikro

# With template
npm create mikro -- --template blinky

# With pnpm
pnpm create mikro --template blinky

# Without questions (as in a script, which must give every answer)
pnpm create mikro my-app --template blinky

# As its own firmware project, for native modules or custom settings
pnpm create mikro --firmware

# A board package: firmware for a development board, and its pin names
pnpm create mikro @acme/devboard --board --chip esp32s3
```

The name is the folder to create the project in, and the package is named after its last segment, as with `npm create vite`: `boards/devboard` creates the package `devboard` in `boards/devboard/`. A scoped name such as `@acme/devboard` is also the package's name.
