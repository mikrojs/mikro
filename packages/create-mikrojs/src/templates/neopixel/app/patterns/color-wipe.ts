import type { NeoPixel } from "mikrojs/neopixel";
import { ok } from "mikrojs/result";
import { sleep } from "mikrojs/sleep";

import { hsv } from "../color.js";

/** Color wipe: fill pixels one by one, then clear one by one */
export async function colorWipe(pixels: NeoPixel, numLeds: number, brightness: number, ms: number) {
  const colors: Array<[number, number, number]> = [
    hsv(0, 1, brightness),
    hsv(120, 1, brightness),
    hsv(240, 1, brightness),
  ];
  const end = Date.now() + ms;
  let ci = 0;
  while (Date.now() < end) {
    const [r, g, b] = colors[ci % colors.length]!;
    for (let i = 0; i < numLeds; i++) {
      const pixelResult = pixels.setPixel(i, r, g, b);
      if (!pixelResult.ok) return pixelResult;
      const showResult = pixels.show();
      if (!showResult.ok) return showResult;
      await sleep(25);
    }
    for (let i = 0; i < numLeds; i++) {
      const pixelResult = pixels.setPixel(i, 0, 0, 0);
      if (!pixelResult.ok) return pixelResult;
      const showResult = pixels.show();
      if (!showResult.ok) return showResult;
      await sleep(25);
    }
    ci++;
  }
  return ok(undefined);
}
