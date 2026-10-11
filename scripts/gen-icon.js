// 生成 build/icon.png：256x256，蓝色圆角底 + 白色文档 + 折角 + 文本线
// 无依赖手写 PNG（zlib deflate + CRC32）
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const W = 256, H = 256;
const px = Buffer.alloc(W * H * 4, 0);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

const inRounded = (x, y, x0, y0, x1, y1, rad) => {
  if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
  const cx = Math.max(x0 + rad, Math.min(x, x1 - rad - 1));
  const cy = Math.max(y0 + rad, Math.min(y, y1 - rad - 1));
  return (x - cx) * (x - cx) + (y - cy) * (y - cy) <= rad * rad;
};

// 蓝色底（圆角）
const BG = [46, 126, 199]; // #2e7ec7
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (inRounded(x, y, 0, 0, W, H, 56)) set(x, y, ...BG);

// 白色文档 x=64..176, y=52..204（右上角折角 40px）
const DX0 = 64, DX1 = 176, DY0 = 52, DY1 = 204, FOLD = 40;
for (let y = DY0; y < DY1; y++)
  for (let x = DX0; x < DX1; x++) {
    if (x > DX1 - FOLD + (y - DY0)) continue; // 折角三角
    set(x, y, 250, 250, 250);
  }
// 折角背面（稍深的灰白三角）
for (let y = DY0; y < DY0 + FOLD; y++)
  for (let x = DX1 - FOLD + (y - DY0); x < DX1; x++)
    if (x <= DX1 - FOLD + (y - DY0) + FOLD * 0.5) set(x, y, 210, 224, 238);

// 文本线（蓝色，4 条，末条短）
const LINES = [
  [86, 96, 154], [86, 118, 154], [86, 140, 154], [86, 162, 124]
];
for (const [x0, y, x1] of LINES)
  for (let yy = y; yy < y + 8; yy++)
    for (let x = x0; x < x1; x++) set(x, yy, ...BG);

// ---- PNG 编码 ----
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(t));
  return Buffer.concat([len, t, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc(H * (W * 4 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0; // filter none
  px.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);
fs.mkdirSync(path.join(__dirname, '..', 'build'), { recursive: true });
fs.writeFileSync(path.join(__dirname, '..', 'build', 'icon.png'), png);
console.log('icon.png written:', png.length, 'bytes');
