// Minimal BlurHash decoder (https://blurha.sh algorithm) — used as the
// loading placeholder for the daily Unsplash photo, per the API guidelines.
// No dependency: the algorithm is ~60 lines of inverse DCT.

const B83 =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~";

function decode83(s: string): number {
  let v = 0;
  for (const c of s) v = v * 83 + B83.indexOf(c);
  return v;
}

function srgbToLinear(v: number): number {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const x = Math.max(0, Math.min(1, v));
  return Math.round(
    (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055) * 255
  );
}

function signPow(v: number, exp: number): number {
  return Math.sign(v) * Math.pow(Math.abs(v), exp);
}

/** Decode a BlurHash into RGBA pixels (returns null on a malformed hash). */
export function decodeBlurHash(
  hash: string,
  width: number,
  height: number
): Uint8ClampedArray | null {
  if (hash.length < 6) return null;
  const sizeFlag = decode83(hash[0]);
  const numY = Math.floor(sizeFlag / 9) + 1;
  const numX = (sizeFlag % 9) + 1;
  if (hash.length !== 4 + 2 * numX * numY) return null;

  const quantMax = decode83(hash[1]);
  const maxValue = (quantMax + 1) / 166;

  const colors: Array<[number, number, number]> = [];
  const dc = decode83(hash.slice(2, 6));
  colors.push([
    srgbToLinear(dc >> 16),
    srgbToLinear((dc >> 8) & 255),
    srgbToLinear(dc & 255),
  ]);
  for (let i = 1; i < numX * numY; i++) {
    const v = decode83(hash.slice(4 + i * 2, 6 + i * 2));
    colors.push([
      signPow((Math.floor(v / (19 * 19)) - 9) / 9, 2) * maxValue,
      signPow((Math.floor(v / 19) % 19 - 9) / 9, 2) * maxValue,
      signPow(((v % 19) - 9) / 9, 2) * maxValue,
    ]);
  }

  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let j = 0; j < numY; j++) {
        for (let i = 0; i < numX; i++) {
          const basis =
            Math.cos((Math.PI * x * i) / width) *
            Math.cos((Math.PI * y * j) / height);
          const c = colors[i + j * numX];
          r += c[0] * basis;
          g += c[1] * basis;
          b += c[2] * basis;
        }
      }
      const p = 4 * (x + y * width);
      pixels[p] = linearToSrgb(r);
      pixels[p + 1] = linearToSrgb(g);
      pixels[p + 2] = linearToSrgb(b);
      pixels[p + 3] = 255;
    }
  }
  return pixels;
}
