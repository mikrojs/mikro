# @mikrojs/lilygo

LilyGo board definitions for Mikro.js.

## Supported boards

### T-Display

1.14" IPS TFT (135x240) with two programmable buttons.

```ts
import {board} from '@mikrojs/lilygo/t-display'
```

| Pin             | Function                       |
| --------------- | ------------------------------ |
| `board.button1` | Left button                    |
| `board.button2` | Right button                   |
| `board.display` | Display configuration (ST7789) |
