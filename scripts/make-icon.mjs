// Generates the Fission app icon (512x512 PNG): a dark rounded square with a
// deep indigo "Z". Zero image dependencies — hand-encodes the PNG.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const S = 512;
const px = new Uint8Array(S * S * 4);

const bg = [14, 16, 20]; // --bg-base
const tile = [27, 31, 39]; // --bg-raised
const accent = [109, 127, 242]; // --accent
const accentHi = [132, 150, 255];

const R = 96; // corner radius
const inside = (x, y) => {
  const m = 16; // margin
  const x0 = m, y0 = m, x1 = S - m, y1 = S - m;
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.max(x0 + R, Math.min(x, x1 - R));
  const cy = Math.max(y0 + R, Math.min(y, y1 - R));
  return (x - cx) ** 2 + (y - cy) ** 2 <= R * R || (x >= x0 + R && x < x1 - R) || (y >= y0 + R && y < y1 - R);
};

// "Z" geometry
const zx0 = 136, zx1 = 376, zy0 = 136, zy1 = 376, bar = 54;
const inZ = (x, y) => {
  if (x < zx0 || x >= zx1 || y < zy0 || y >= zy1) return false;
  if (y < zy0 + bar) return true; // top bar
  if (y >= zy1 - bar) return true; // bottom bar
  // diagonal from top-right to bottom-left
  const t = (y - (zy0 + bar)) / (zy1 - bar - (zy0 + bar));
  const cx = zx1 - bar / 2 - t * (zx1 - zx0 - bar);
  return Math.abs(x - cx) <= bar * 0.72;
};

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    let c = [0, 0, 0, 0];
    if (inside(x, y)) {
      // subtle vertical sheen on the tile
      const sheen = 1 + 0.10 * (1 - y / S);
      c = [tile[0] * sheen, tile[1] * sheen, tile[2] * sheen, 255];
      if (inZ(x, y)) {
        const t = y / S;
        c = [
          accent[0] * (1 - t) + accentHi[0] * t,
          accent[1] * (1 - t) + accentHi[1] * t,
          accent[2] * (1 - t) + accentHi[2] * t,
          255,
        ];
      }
    } else if (x > 0 && y > 0) {
      c = [bg[0], bg[1], bg[2], 0];
    }
    px[i] = c[0]; px[i + 1] = c[1]; px[i + 2] = c[2]; px[i + 3] = c[3];
  }
}

// PNG encode (filter 0 per scanline)
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
mkdirSync("scripts/out", { recursive: true });
writeFileSync("scripts/out/icon-source.png", png);
console.log("wrote scripts/out/icon-source.png");
