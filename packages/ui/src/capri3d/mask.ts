export const MASK_COLUMNS = 24;
export const MASK_ROWS = 34;
/** Conservative occupancy: any opaque pixel marks its cell. Input and output are top-to-bottom. */
export function encodeAlphaMask(
 rgba: Uint8Array | Uint8ClampedArray, width: number, height: number,
 columns = MASK_COLUMNS, rows = MASK_ROWS,
): number[] {
 if (![width, height, columns, rows].every(n => Number.isInteger(n) && n > 0) || rgba.length !== width * height * 4)
  throw new Error("Invalid alpha buffer dimensions");
 const mask = Array<number>(columns * rows).fill(0);
 for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
  if ((rgba[(y * width + x) * 4 + 3] ?? 0) > 24)
   mask[Math.floor(y * rows / height) * columns + Math.floor(x * columns / width)] = 1;
 }
 return mask;
}
