// Lightweight zero-dependency GIF89a encoder with fixed 256-colour weather palette + 5-5-5 RGB LUT.

function parseRgb(col) {
  if (Array.isArray(col) && col.length >= 3) return [col[0] & 255, col[1] & 255, col[2] & 255];
  const h = String(col || '').trim().replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(h)) {
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null;
}

function buildPaletteAndLut(customColors = []) {
  const palette = [];
  const seen = new Set();
  const push = (rgb) => {
    if (!rgb || palette.length >= 256) return;
    const k = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    if (seen.has(k)) return;
    seen.add(k);
    palette.push(rgb);
  };

  // Reserve exact brand, radar, strike, and risk-band colours first
  for (const c of customColors) push(parseRgb(c));

  // Fill remainder (up to 256 total) from 6x6x6 uniform RGB cube + extra greyscale steps
  for (const g of [0, 32, 64, 96, 128, 160, 192, 224, 240, 255]) push([g, g, g]);
  const levels = [0, 51, 102, 153, 204, 255];
  for (const r of levels) {
    for (const g of levels) {
      for (const b of levels) push([r, g, b]);
    }
  }
  while (palette.length < 256) palette.push([0, 0, 0]);

  // Precompute 32,768-entry 5-5-5 RGB -> palette index lookup table
  const lut = new Uint8Array(32768);
  const pLen = palette.length;
  for (let r5 = 0; r5 < 32; r5++) {
    const r = (r5 << 3) | (r5 >> 2);
    for (let g5 = 0; g5 < 32; g5++) {
      const g = (g5 << 3) | (g5 >> 2);
      for (let b5 = 0; b5 < 32; b5++) {
        const b = (b5 << 3) | (b5 >> 2);
        let bestIdx = 0;
        let bestDist = Infinity;
        for (let i = 0; i < pLen; i++) {
          const pr = palette[i][0], pg = palette[i][1], pb = palette[i][2];
          const dr = r - pr, dg = g - pg, db = b - pb;
          // Weighted luminance perception squared distance
          const dist = dr * dr * 3 + dg * dg * 4 + db * db * 2;
          if (dist < bestDist) {
            bestDist = dist;
            bestIdx = i;
            if (dist === 0) break;
          }
        }
        lut[(r5 << 10) | (g5 << 5) | b5] = bestIdx;
      }
    }
  }
  return { palette, lut };
}

class ByteBuf {
  constructor(initCap = 4096) {
    this.buf = new Uint8Array(initCap);
    this.len = 0;
  }
  grow(need) {
    if (this.len + need <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.len + need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  u8(v) {
    this.grow(1);
    this.buf[this.len++] = v & 255;
  }
  u16(v) {
    this.grow(2);
    this.buf[this.len++] = v & 255;
    this.buf[this.len++] = (v >> 8) & 255;
  }
  bytes(arr) {
    this.grow(arr.length);
    this.buf.set(arr, this.len);
    this.len += arr.length;
  }
  ascii(str) {
    this.grow(str.length);
    for (let i = 0; i < str.length; i++) this.buf[this.len++] = str.charCodeAt(i);
  }
  toUint8Array() {
    return this.buf.subarray(0, this.len);
  }
}

export function createGifEncoder({ width, height, paletteColors = [] }) {
  const { palette, lut } = buildPaletteAndLut(paletteColors);
  const chunks = [];
  const head = new ByteBuf(1024);

  // GIF89a header + Logical Screen Descriptor + 256-colour Global Color Table
  head.ascii('GIF89a');
  head.u16(width);
  head.u16(height);
  head.u8(0xf7); // GCT present, 8-bit colour resolution, 256 entries (2^(7+1))
  head.u8(0);    // background colour index
  head.u8(0);    // pixel aspect ratio
  for (const [r, g, b] of palette) {
    head.u8(r);
    head.u8(g);
    head.u8(b);
  }

  // Netscape 2.0 infinite loop extension
  head.bytes([0x21, 0xff, 0x0b]);
  head.ascii('NETSCAPE2.0');
  head.bytes([0x03, 0x01, 0x00, 0x00, 0x00]);
  chunks.push(head.toUint8Array());

  const nPix = width * height;
  const indices = new Uint8Array(nPix);
  const HASH_SIZE = 16381; // prime hash table size (> 4 * 4096)
  const hTab = new Int32Array(HASH_SIZE);
  const codeTab = new Uint16Array(HASH_SIZE);

  function addFrame(rgba, delayCs = 18) {
    for (let i = 0, o = 0; i < nPix; i++, o += 4) {
      if (rgba[o + 3] === 0) {
        indices[i] = lut[(31 << 10) | (31 << 5) | 31];
      } else {
        indices[i] = lut[((rgba[o] >> 3) << 10) | ((rgba[o + 1] >> 3) << 5) | (rgba[o + 2] >> 3)];
      }
    }

    const f = new ByteBuf(Math.max(4096, nPix >> 1));
    // Graphic Control Extension
    f.bytes([0x21, 0xf9, 0x04, 0x00]);
    f.u16(Math.max(2, Math.round(delayCs)));
    f.bytes([0x00, 0x00]);

    // Image Descriptor (full frame)
    f.u8(0x2c);
    f.u16(0);
    f.u16(0);
    f.u16(width);
    f.u16(height);
    f.u8(0x00);

    // LZW raster image data (min code size = 8)
    f.u8(8);
    const CLEAR = 256;
    const EOI = 257;
    let codeSize = 9;
    let maxCode = 512;
    let nextCode = 258;
    let accum = 0;
    let bits = 0;
    const sub = new Uint8Array(256);
    let subLen = 0;

    const flushSub = () => {
      if (!subLen) return;
      f.u8(subLen);
      f.bytes(sub.subarray(0, subLen));
      subLen = 0;
    };

    const emit = (code) => {
      accum |= (code & ((1 << codeSize) - 1)) << bits;
      bits += codeSize;
      while (bits >= 8) {
        sub[subLen++] = accum & 255;
        if (subLen === 255) flushSub();
        accum >>>= 8;
        bits -= 8;
      }
    };

    hTab.fill(-1);
    emit(CLEAR);

    let ent = indices[0];
    for (let i = 1; i < nPix; i++) {
      const c = indices[i];
      const fcode = (c << 12) | ent;
      let idx = (((c << 6) + ent * 17) % HASH_SIZE);
      if (idx < 0) idx += HASH_SIZE;

      let hit = false;
      while (hTab[idx] !== -1) {
        if (hTab[idx] === fcode) {
          ent = codeTab[idx];
          hit = true;
          break;
        }
        idx--;
        if (idx < 0) idx += HASH_SIZE;
      }
      if (hit) continue;

      emit(ent);
      ent = c;

      if (nextCode < 4096) {
        if (nextCode === maxCode) {
          codeSize++;
          maxCode <<= 1;
        }
        hTab[idx] = fcode;
        codeTab[idx] = nextCode++;
      } else {
        emit(CLEAR);
        hTab.fill(-1);
        nextCode = 258;
        codeSize = 9;
        maxCode = 512;
      }
    }

    emit(ent);
    if (nextCode === maxCode && maxCode < 4096) codeSize++;
    emit(EOI);
    if (bits > 0) {
      sub[subLen++] = accum & 255;
      flushSub();
    } else {
      flushSub();
    }
    f.u8(0); // block terminator
    chunks.push(f.toUint8Array());
  }

  function finish() {
    chunks.push(new Uint8Array([0x3b])); // GIF trailer
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return new Blob([out], { type: 'image/gif' });
  }

  return { addFrame, finish };
}
