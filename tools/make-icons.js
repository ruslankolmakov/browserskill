#!/usr/bin/env node
/* Генератор иконок расширения.
 *
 * Chrome обязателен iconUrl для notifications типа basic, а класть в репозиторий
 * бинарники без исходника неудобно — проще держать сам рисунок кодом.
 * Запуск: node tools/make-icons.js
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const OUT = path.join(__dirname, "..", "extension-chrome", "icons");

const BG = [24, 26, 32]; // тёмный графит
const FG = [18, 161, 80]; // зелёный «мост поднят»

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // фильтр «none»
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o++] = r;
      raw[o++] = g;
      raw[o++] = b;
      raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Скруглённый квадрат с «мостом»: горизонтальная балка и две опоры.
function draw(x, y, size) {
  const u = size / 16; // сетка 16×16 независимо от реального размера
  const gx = x / u;
  const gy = y / u;

  const r = 3.2;
  const dx = Math.max(r - gx, gx - (16 - r), 0);
  const dy = Math.max(r - gy, gy - (16 - r), 0);
  if (Math.hypot(dx, dy) > r) return [0, 0, 0, 0];

  const inside = (x0, y0, x1, y1) => gx >= x0 && gx <= x1 && gy >= y0 && gy <= y1;
  const deck = inside(2.5, 7, 13.5, 8.8);
  const pylonL = inside(4, 4.2, 5.4, 12);
  const pylonR = inside(10.6, 4.2, 12, 12);
  if (deck || pylonL || pylonR) return [...FG, 255];
  return [...BG, 255];
}

fs.mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(OUT, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, draw));
  console.log("✅", path.relative(path.join(__dirname, ".."), file));
}
