import type { NeoPixel } from "mikro/neopixel";
import { ok } from "mikro/result";
import { sleep } from "mikro/sleep";

import { hsv } from "../color.js";

/** Sparkle: random pixels flash white on a dim background */
export async function sparkle(pixels: NeoPixel, numLeds: number, brightness: number, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const [br, bg, bb] = hsv(270, 0.8, brightness * 0.15);
    const fillResult = pixels.fill(br, bg, bb);
    if (!fillResult.ok) return fillResult;
    for (let s = 0; s < 3; s++) {
      const idx = Math.floor(Math.random() * numLeds);
      const v = brightness * (0.5 + Math.random() * 0.5) * 255;
      const pixelResult = pixels.setPixel(idx, v, v, v);
      if (!pixelResult.ok) return pixelResult;
    }
    const showResult = pixels.show();
    if (!showResult.ok) return showResult;
    await sleep(60);
  }
  return ok();
}
