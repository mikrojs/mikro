import type { NeoPixel } from "mikro/neopixel";
import { ok } from "mikro/result";
import { sleep } from "mikro/sleep";

import { hsv } from "../color.js";

/** Breathe: all LEDs pulse a single color in and out */
export async function breathe(pixels: NeoPixel, numLeds: number, brightness: number, ms: number) {
  const end = Date.now() + ms;
  let t = 0;
  while (Date.now() < end) {
    const v = ((Math.sin(t) + 1) / 2) * brightness;
    const [r, g, b] = hsv(30, 1, v);
    const fillResult = pixels.fill(r, g, b);
    if (!fillResult.ok) return fillResult;
    const showResult = pixels.show();
    if (!showResult.ok) return showResult;
    t += 0.06;
    await sleep(20);
  }
  return ok(undefined);
}
