/** Convert HSV (h: 0–360, s: 0–1, v: 0–1) to RGB tuple */
export function hsv(h: number, s: number, v: number): [r: number, g: number, b: number] {
  h = h % 360;
  const max = v * 255;
  const min = max * (1 - s);
  const sector = Math.floor(h / 60);
  const adj = ((max - min) * (h % 60)) / 60;

  switch (sector) {
    case 0:
      return [max, min + adj, min];
    case 1:
      return [max - adj, max, min];
    case 2:
      return [min, max, min + adj];
    case 3:
      return [min, max - adj, max];
    case 4:
      return [min + adj, min, max];
    default:
      return [max, min, max - adj];
  }
}
