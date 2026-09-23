#!/usr/bin/env node
/**
 * 生成演示用的图片与音频，零依赖（只用 node:zlib）。
 *
 * 为什么不用现成素材：站点的图片/音频版权是最容易被投诉的地方。
 * 这里用程序合成 CC0 素材，替换成你自己的作品即可。
 *
 *   npm run gen:assets
 *
 * 产物：
 *   src/assets/generated/*.png   → 交给 Astro 在构建期转 AVIF/WebP + 多尺寸
 *   public/audio/demo.wav        → 演示音频（真音频请换成 mp3/opus）
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ----------------------------- PNG 编码 ----------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行前置 1 字节 filter(0)，再交给 zlib
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 生成一张柔和的渐变图：几个径向光斑 + 对角渐变，压缩率高、体积小。 */
function makeGradient(width, height, palette, seed = 1) {
  const buf = Buffer.alloc(width * height * 3);
  const blobs = palette.blobs.map((b, i) => ({
    x: b.x * width,
    y: b.y * height,
    r: b.r * Math.max(width, height),
    color: b.color,
    // 轻微的伪随机偏移，避免每张图完全一样
    px: Math.sin(seed * (i + 1.7)) * 0.06,
    py: Math.cos(seed * (i + 2.3)) * 0.06,
  }));

  for (let y = 0; y < height; y++) {
    const v = y / height;
    for (let x = 0; x < width; x++) {
      const u = x / width;

      // 底：对角渐变
      let r = palette.base[0] + (palette.base2[0] - palette.base[0]) * (u * 0.6 + v * 0.4);
      let g = palette.base[1] + (palette.base2[1] - palette.base[1]) * (u * 0.6 + v * 0.4);
      let b = palette.base[2] + (palette.base2[2] - palette.base[2]) * (u * 0.6 + v * 0.4);

      for (const blob of blobs) {
        const dx = u - (blob.x / width + blob.px);
        const dy = v - (blob.y / height + blob.py);
        const d = Math.sqrt(dx * dx + dy * dy) / (blob.r / Math.max(width, height));
        const falloff = Math.max(0, 1 - d);
        const w = falloff * falloff * falloff;
        r += (blob.color[0] - r) * w;
        g += (blob.color[1] - g) * w;
        b += (blob.color[2] - b) * w;
      }

      const i = (y * width + x) * 3;
      buf[i] = Math.max(0, Math.min(255, Math.round(r)));
      buf[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      buf[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }

  return encodePng(width, height, buf);
}

/* ----------------------------- WAV 编码 ----------------------------- */

/** 合成一段 12 秒的氛围音：三个正弦分音 + 缓慢 LFO，带淡入淡出。 */
function makeAmbientWav({ seconds = 12, sampleRate = 22050 } = {}) {
  const total = Math.floor(seconds * sampleRate);
  const data = Buffer.alloc(total * 2); // 16-bit mono

  const partials = [
    { freq: 110.0, gain: 0.34, lfo: 0.07 },
    { freq: 164.81, gain: 0.22, lfo: 0.11 },
    { freq: 220.0, gain: 0.14, lfo: 0.05 },
    { freq: 329.63, gain: 0.07, lfo: 0.09 },
  ];

  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    let s = 0;
    for (const p of partials) {
      const lfo = 0.65 + 0.35 * Math.sin(2 * Math.PI * p.lfo * t);
      s += Math.sin(2 * Math.PI * p.freq * t) * p.gain * lfo;
    }
    // 起止各 1.2s 淡入淡出
    const fade = Math.min(1, t / 1.2, (seconds - t) / 1.2);
    s *= Math.max(0, fade) * 0.55;

    const clamped = Math.max(-1, Math.min(1, s));
    data.writeInt16LE(Math.round(clamped * 32767), i * 2);
  }

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM header size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

/* ------------------------------- 执行 ------------------------------- */

const generatedDir = resolve(root, 'src/assets/generated');
const audioDir = resolve(root, 'public/audio');
mkdirSync(generatedDir, { recursive: true });
mkdirSync(audioDir, { recursive: true });

const images = [
  {
    file: 'hero-poster.png',
    w: 1600,
    h: 900,
    seed: 1,
    palette: {
      base: [8, 10, 18],
      base2: [22, 18, 44],
      blobs: [
        { x: 0.15, y: 0.2, r: 0.55, color: [70, 200, 255] },
        { x: 0.85, y: 0.15, r: 0.5, color: [150, 120, 255] },
        { x: 0.6, y: 0.9, r: 0.6, color: [230, 150, 255] },
      ],
    },
  },
  {
    file: 'shot-a.png',
    w: 1200,
    h: 800,
    seed: 2,
    palette: {
      base: [10, 14, 24],
      base2: [16, 30, 40],
      blobs: [
        { x: 0.25, y: 0.3, r: 0.5, color: [90, 230, 255] },
        { x: 0.75, y: 0.7, r: 0.45, color: [40, 120, 200] },
      ],
    },
  },
  {
    file: 'shot-b.png',
    w: 1200,
    h: 800,
    seed: 3,
    palette: {
      base: [14, 10, 26],
      base2: [34, 18, 44],
      blobs: [
        { x: 0.7, y: 0.25, r: 0.5, color: [180, 130, 255] },
        { x: 0.2, y: 0.75, r: 0.5, color: [240, 140, 220] },
      ],
    },
  },
  {
    file: 'shot-c.png',
    w: 1200,
    h: 800,
    seed: 4,
    palette: {
      base: [8, 16, 18],
      base2: [12, 34, 32],
      blobs: [
        { x: 0.5, y: 0.2, r: 0.55, color: [120, 255, 210] },
        { x: 0.3, y: 0.8, r: 0.45, color: [60, 150, 255] },
      ],
    },
  },
];

for (const img of images) {
  const png = makeGradient(img.w, img.h, img.palette, img.seed);
  const out = resolve(generatedDir, img.file);
  writeFileSync(out, png);
  console.log(`✓ ${out.replace(root + '/', '')}  (${(png.length / 1024).toFixed(0)} KB)`);
}

const wav = makeAmbientWav();
const wavPath = resolve(audioDir, 'demo.wav');
writeFileSync(wavPath, wav);
console.log(`✓ ${wavPath.replace(root + '/', '')}  (${(wav.length / 1024).toFixed(0)} KB)`);

console.log('\n完成。把 src/assets/generated/ 与 public/audio/ 换成你自己的素材即可。');
