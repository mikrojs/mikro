# @mikrojs/driver-st7789

Pure JavaScript SPI display driver for ST7789 controller chips. Uses `mikrojs/spi` under the hood; no native code required.

## API

```ts
import {createDisplay} from '@mikrojs/driver-st7789'

const display = createDisplay({
  width: 135,
  height: 240,
  spi: {cs: 5, dc: 16, sck: 18, mosi: 19},
  reset: 23,
  backlight: 4,
})

display.fillScreen(0x0000) // Clear to black
display.fillRect(10, 10, 50, 50, color) // Draw a rectangle
```

Used by the [`@mikrojs/lilygo`](../lilygo) board package.
