// generate-icons.js — writes icons/icon{16,48,128}.png with no dependencies.
// Draws an indigo rounded square with a white download arrow.
// Run once: `node generate-icons.js`

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, pixels /* RGBA Uint8Array */) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // 10,11,12 = compression, filter, interlace = 0

  // Add filter byte (0) at the start of each scanline.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.subarray(y * stride, y * stride + stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = zlib.deflateSync(raw);

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function drawIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const bg = [79, 70, 229]; // indigo
  const fg = [255, 255, 255];
  const radius = size * 0.18;

  const set = (x, y, c) => {
    const i = (y * size + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = 255;
  };

  // Rounded-rect background.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inCorner =
        (x < radius && y < radius && Math.hypot(radius - x, radius - y) > radius) ||
        (x > size - radius && y < radius && Math.hypot(x - (size - radius), radius - y) > radius) ||
        (x < radius && y > size - radius && Math.hypot(radius - x, y - (size - radius)) > radius) ||
        (x > size - radius && y > size - radius && Math.hypot(x - (size - radius), y - (size - radius)) > radius);
      if (inCorner) {
        const i = (y * size + x) * 4;
        px[i + 3] = 0; // transparent corner
      } else {
        set(x, y, bg);
      }
    }
  }

  // Download arrow: stem + arrowhead + base tray.
  const cx = size / 2;
  const stemW = Math.max(2, size * 0.1);
  const stemTop = size * 0.24;
  const stemBottom = size * 0.5;
  const headTop = size * 0.44;
  const headBottom = size * 0.66;
  const headHW = size * 0.22;
  const trayY = size * 0.74;
  const trayH = Math.max(2, size * 0.08);
  const trayHW = size * 0.26;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // stem
      if (y >= stemTop && y <= stemBottom && Math.abs(x - cx) <= stemW / 2) set(x, y, fg);
      // arrowhead (triangle)
      if (y >= headTop && y <= headBottom) {
        const hw = headHW * (1 - (y - headTop) / (headBottom - headTop));
        if (Math.abs(x - cx) <= hw) set(x, y, fg);
      }
      // tray
      if (y >= trayY && y <= trayY + trayH && Math.abs(x - cx) <= trayHW) set(x, y, fg);
    }
  }

  return encodePng(size, px);
}

const outDir = path.join(__dirname, "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), drawIcon(size));
  console.log(`wrote icons/icon${size}.png`);
}
