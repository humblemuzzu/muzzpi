/**
 * Minimal PNG decode / encode / crop / orient for the vision pipeline,
 * adapted from caliper's src/png.ts.
 */

import { closeSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { PNG as PngClass } from "pngjs";
import type { Box } from "./vision";

let pngClass: typeof PngClass | undefined;
function Png(): typeof PngClass {
  pngClass ??= (createRequire(import.meta.url)("pngjs") as { PNG: typeof PngClass }).PNG;
  return pngClass;
}

// pngjs is ^7 but @types/pngjs stops at 6.0.5. Only PNG.sync.read/write and
// the PNG constructor are used, and those did not change across the major.

/** A decoded image. `rgb` is 3 bytes per pixel, row-major, no padding. */
export interface Image {
  width: number;
  height: number;
  rgb: Uint8Array;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width and height from the IHDR chunk; reads 24 bytes, decodes nothing. */
export function readPngSize(path: string): { width: number; height: number } {
  const head = Buffer.alloc(24);
  const fd = openSync(path, "r");
  let got: number;
  try {
    got = readSync(fd, head, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  return pngSizeFromHeader(head.subarray(0, got), path);
}

export function pngSizeFromHeader(head: Buffer, path = "image"): { width: number; height: number } {
  if (head.length < 24) throw new Error(`not a PNG: ${path} is only ${head.length} bytes`);
  if (!head.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`not a PNG: ${path} has a bad signature`);
  }
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

export function load(path: string): Image {
  const png = Png().sync.read(readFileSync(path));
  const pixels = png.width * png.height;
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const alpha = png.data[i * 4 + 3] as number;
    // Flattened onto white here so transparent corners of a window capture
    // look the same every time, instead of however the API composites them.
    for (let channel = 0; channel < 3; channel += 1) {
      const value = png.data[i * 4 + channel] as number;
      rgb[i * 3 + channel] = Math.round((value * alpha + 255 * (255 - alpha)) / 255);
    }
  }
  return { width: png.width, height: png.height, rgb };
}

export function encode(img: Image): Buffer {
  const PNG = Png();
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.width * img.height; i += 1) {
    png.data[i * 4] = img.rgb[i * 3] as number;
    png.data[i * 4 + 1] = img.rgb[i * 3 + 1] as number;
    png.data[i * 4 + 2] = img.rgb[i * 3 + 2] as number;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function save(img: Image, path: string): void {
  writeFileSync(path, encode(img));
}

export function crop(img: Image, box: Box): Image {
  if (
    box.x < 0 ||
    box.y < 0 ||
    box.width <= 0 ||
    box.height <= 0 ||
    box.x + box.width > img.width ||
    box.y + box.height > img.height
  ) {
    throw new Error(
      `crop box ${box.x},${box.y} ${box.width}×${box.height} falls outside ${img.width}×${img.height}`,
    );
  }
  const rgb = new Uint8Array(box.width * box.height * 3);
  for (let y = 0; y < box.height; y += 1) {
    const from = (box.y + y) * img.width + box.x;
    rgb.set(img.rgb.subarray(from * 3, (from + box.width) * 3), y * box.width * 3);
  }
  return { width: box.width, height: box.height, rgb };
}

/**
 * Apply an EXIF orientation (1-8) so the pixels are upright. For each output
 * pixel, `source` returns where it comes from in the stored image.
 */
export function orient(img: Image, orientation: number): Image {
  if (orientation < 2 || orientation > 8) return img;
  const { width: W, height: H } = img;
  const swap = orientation >= 5;
  const outW = swap ? H : W;
  const outH = swap ? W : H;
  const source: (x: number, y: number) => number = {
    2: (x: number, y: number) => y * W + (W - 1 - x),
    3: (x: number, y: number) => (H - 1 - y) * W + (W - 1 - x),
    4: (x: number, y: number) => (H - 1 - y) * W + x,
    5: (x: number, y: number) => x * W + y,
    6: (x: number, y: number) => (H - 1 - x) * W + y,
    7: (x: number, y: number) => (H - 1 - x) * W + (W - 1 - y),
    8: (x: number, y: number) => x * W + (W - 1 - y),
  }[orientation]!;

  const rgb = new Uint8Array(outW * outH * 3);
  for (let y = 0; y < outH; y += 1) {
    for (let x = 0; x < outW; x += 1) {
      const from = source(x, y) * 3;
      const to = (y * outW + x) * 3;
      rgb[to] = img.rgb[from] as number;
      rgb[to + 1] = img.rgb[from + 1] as number;
      rgb[to + 2] = img.rgb[from + 2] as number;
    }
  }
  return { width: outW, height: outH, rgb };
}
