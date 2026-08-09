// GoldenEye and Perfect Dark share this texture codec. This is a TypeScript
// translation of the documented texInflate* path in GE's image.c and Rare's
// libpdtex reader. Generated mip levels are retained alongside the base image.

export interface DecodedTexture {
    width: number;
    height: number;
    pixels: Uint8Array;
    lods: { width: number; height: number; pixels: Uint8Array }[];
}

export type RawDeflateInflater = (data: Uint8Array) => Uint8Array;

const channels = [4, 3, 3, 3, 2, 2, 1, 1, 1, 1, 1, 1, 1];
const oneBitAlpha = [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0];
const channelSizes = [256, 32, 256, 32, 256, 16, 8, 256, 16, 256, 16, 256, 16];
const bitsPerPixel = [32, 16, 24, 15, 16, 8, 4, 8, 4, 16, 16, 16, 16];

class BitReader {
    public offset = 0;
    private value = 0;
    private bits = 0;
    constructor(public data: Uint8Array) {}
    public read(n: number): number {
        while (this.bits < n) {
            if (this.offset >= this.data.length)
                throw new Error('texture bitstream overrun');
            this.value = this.data[this.offset++] | (this.value << 8);
            this.bits += 8;
        }
        this.bits -= n;
        if (n === 32)
            return this.value >>> 0;
        return (this.value >>> this.bits) & (2 ** n - 1);
    }
    public resetAt(offset: number): void {
        this.offset = offset;
        this.value = 0;
        this.bits = 0;
    }
}

function inflateHuffman(br: BitReader, count: number, size: number): Uint16Array {
    const frequencies = new Uint16Array(2048).fill(9999);
    const left = new Int16Array(2048).fill(-1);
    const right = new Int16Array(2048).fill(-1);
    for (let i = 0; i < size; i++) frequencies[i] = br.read(8);
    let root = 0, f1 = 9999, f2 = 9999, i1 = 0, i2 = 0;
    // Preserve Rare's tie-breaking exactly; equal-frequency trees otherwise
    // consume a different bit sequence even though both trees are valid.
    for (let i = 0; i < size; i++) {
        const f = frequencies[i];
        if (f < f1) {
            if (f2 < f1) { f1 = f; i1 = i; }
            else { f2 = f; i2 = i; }
        } else if (f < f2) { f2 = f; i2 = i; }
    }
    for (;;) {
        let sum = f1 + f2; if (sum === 0) sum = 1;
        frequencies[i1] = frequencies[i2] = 9999;
        if (left[i1] < 0 && right[i1] < 0) {
            left[i1] = i1 + 10000; right[i1] = left[i2] < 0 && right[i2] < 0 ? i2 + 10000 : i2;
            root = i1; frequencies[i1] = sum;
        } else if (left[i2] < 0 && right[i2] < 0) {
            left[i2] = i2 + 10000; right[i2] = left[i1] < 0 && right[i1] < 0 ? i1 + 10000 : i1;
            root = i2; frequencies[i2] = sum;
        } else {
            for (root = 0; left[root] >= 0 || right[root] >= 0 || frequencies[root] < 9999; root++);
            frequencies[root] = sum; left[root] = i1; right[root] = i2;
        }
        f1 = f2 = 9999;
        for (let i = 0; i < size; i++) {
            const f = frequencies[i];
            if (f < f1) {
                if (f1 > f2) { f1 = f; i1 = i; }
                else { f2 = f; i2 = i; }
            } else if (f < f2) { f2 = f; i2 = i; }
        }
        if (f1 === 9999 || f2 === 9999) break;
    }
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
        let v = root;
        while (v < 10000) v = br.read(1) ? right[v] : left[v];
        out[i] = v - 10000;
    }
    return out;
}

function inflateRLE(br: BitReader, count: number): Uint16Array {
    const backBits = br.read(3), runBits = br.read(3), valueBits = br.read(4);
    let cost = backBits + runBits + valueBits + 1, fudge = 0;
    while (cost > 0) { cost -= valueBits + 1; fudge++; }
    const out = new Uint16Array(count);
    let n = 0;
    while (n < count) {
        if (br.read(1) === 0) out[n++] = br.read(valueBits);
        else {
            const start = n - br.read(backBits) - 1;
            const run = br.read(runBits) + fudge;
            for (let i = 0; i < run && n < count; i++) out[n++] = out[start + i];
            if (n < count) out[n++] = br.read(valueBits);
        }
    }
    return out;
}

function buildLookup(br: BitReader, bpp: number): { values: Uint32Array; count: number } {
    const count = br.read(11);
    const values = new Uint32Array(count);
    for (let i = 0; i < count; i++)
        values[i] = bpp <= 24 ? br.read(bpp) : (br.read(24) * 0x100 + br.read(bpp - 24)) >>> 0;
    return { values, count };
}

function bitSize(n: number): number {
    let bits = 0; for (n--; n > 0; n >>>= 1) bits++; return bits;
}

function blur(values: Uint16Array, width: number, height: number, method: number, size: number): void {
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = y * width + x, cur = values[p] + size * 2;
        const l = x ? values[p - 1] : 0, a = y ? values[p - width] : 0, al = x && y ? values[p - width - 1] : 0;
        const pred = method === 0 ? l : method === 1 ? a : method === 2 ? al : method === 3 ? l + a - al : method === 4 ? Math.trunc((a - al) / 2) + l : method === 5 ? Math.trunc((l - al) / 2) + a : Math.trunc((l + a) / 2);
        values[p] = (cur + pred) % size;
    }
}

function rgba16(v: number, dst: Uint8Array, p: number): void {
    dst[p] = ((v >>> 11) & 0x1F) * 255 / 31;
    dst[p + 1] = ((v >>> 6) & 0x1F) * 255 / 31;
    dst[p + 2] = ((v >>> 1) & 0x1F) * 255 / 31;
    dst[p + 3] = (v & 1) ? 255 : 0;
}

function rawToRGBA(format: number, raw: Uint16Array, width: number, height: number): Uint8Array {
    const count = width * height, out = new Uint8Array(count * 4);
    const mult = count;
    for (let i = 0; i < count; i++) {
        const p = i * 4;
        if (format === 0) { out[p] = raw[i]; out[p + 1] = raw[i + mult]; out[p + 2] = raw[i + 2 * mult]; out[p + 3] = raw[i + 3 * mult]; }
        else if (format === 1 || format === 3) { const v = (raw[i] << 11) | (raw[i + mult] << 6) | (raw[i + 2 * mult] << 1) | (format === 3 ? 1 : raw[i + 3 * mult]); rgba16(v, out, p); }
        else if (format === 2) { out[p] = raw[i]; out[p + 1] = raw[i + mult]; out[p + 2] = raw[i + 2 * mult]; out[p + 3] = 255; }
        else if (format === 4) { out[p] = out[p + 1] = out[p + 2] = raw[i]; out[p + 3] = raw[i + mult]; }
        else if (format === 5) { const intensity = raw[i] * 17; out[p] = out[p + 1] = out[p + 2] = intensity; out[p + 3] = raw[i + mult] * 17; }
        else if (format === 6) { const intensity = raw[i] * 255 / 7; out[p] = out[p + 1] = out[p + 2] = intensity; out[p + 3] = raw[i + mult] ? 255 : 0; }
        else if (format === 7 || format === 8) { const intensity = format === 8 ? raw[i] * 16 : raw[i]; out[p] = out[p + 1] = out[p + 2] = intensity; out[p + 3] = 255; }
    }
    return out;
}

function packedToRGBA(format: number, values: Uint32Array | Uint16Array, width: number, height: number): Uint8Array {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        const v = values[i] >>> 0, p = i * 4;
        if (format === 0) { out[p] = v >>> 24; out[p + 1] = v >>> 16; out[p + 2] = v >>> 8; out[p + 3] = v; }
        else if (format === 1 || format === 3) rgba16(format === 3 ? ((v << 1) | 1) : v, out, p);
        else if (format === 2) { out[p] = v >>> 16; out[p + 1] = v >>> 8; out[p + 2] = v; out[p + 3] = 255; }
        else if (format === 4) { out[p] = out[p + 1] = out[p + 2] = v >>> 8; out[p + 3] = v; }
        else if (format === 5) { out[p] = out[p + 1] = out[p + 2] = ((v >>> 4) & 0xF) * 17; out[p + 3] = (v & 0xF) * 17; }
        else if (format === 6) { out[p] = out[p + 1] = out[p + 2] = ((v >>> 1) & 7) * 255 / 7; out[p + 3] = (v & 1) ? 255 : 0; }
        else { const intensity = format === 8 ? (v & 0xF) * 16 : v & 0xFF; out[p] = out[p + 1] = out[p + 2] = intensity; out[p + 3] = 255; }
    }
    return out;
}

function finishTexture(width: number, height: number, pixels: Uint8Array, lodCount: number): DecodedTexture {
    const lods: DecodedTexture['lods'] = [];
    let srcWidth = width, srcHeight = height, src = pixels;
    for (let level = 1; level < lodCount; level++) {
        const dstWidth = (srcWidth + 1) >>> 1, dstHeight = (srcHeight + 1) >>> 1;
        const dst = new Uint8Array(dstWidth * dstHeight * 4);
        for (let y = 0; y < dstHeight; y++) {
            for (let x = 0; x < dstWidth; x++) {
                const sums = [0, 0, 0, 0];
                let samples = 0;
                for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                    const sx = x * 2 + dx, sy = y * 2 + dy;
                    if (sx >= srcWidth || sy >= srcHeight) continue;
                    const p = (sy * srcWidth + sx) * 4;
                    for (let c = 0; c < 4; c++) sums[c] += src[p + c];
                    samples++;
                }
                const p = (y * dstWidth + x) * 4;
                for (let c = 0; c < 4; c++) dst[p + c] = Math.round(sums[c] / samples);
            }
        }
        lods.push({ width: dstWidth, height: dstHeight, pixels: dst });
        srcWidth = dstWidth; srcHeight = dstHeight; src = dst;
    }
    return { width, height, pixels, lods };
}

export function decodeGoldenEyeTexture(data: Uint8Array, inflateRaw: RawDeflateInflater): DecodedTexture {
    const br = new BitReader(data);
    const hasExplicitLODs = br.read(1), zlib = br.read(1), lodCount = br.read(6);
    if (zlib) {
        const format = br.read(8), colours = br.read(8) + 1;
        const palette = new Uint16Array(colours);
        for (let i = 0; i < colours; i++) palette[i] = br.read(16);
        const width = br.read(8), height = br.read(8);
        // The bit reader is byte aligned here. Rare's 1173 header is five
        // bytes, followed by a raw DEFLATE stream.
        const start = br.offset;
        if (data[start] !== 0x11 || (data[start + 1] !== 0x72 && data[start + 1] !== 0x73))
            throw new Error('invalid zlib texture header');
        const headerSize = data[start + 1] === 0x73 ? 5 : 2;
        const indices = inflateRaw(data.subarray(start + headerSize));
        const out = new Uint8Array(width * height * 4);
        const ci4 = format === 10 || format === 12;
        for (let i = 0; i < width * height; i++) {
            const index = ci4 ? ((indices[i >>> 1] >>> ((i & 1) ? 0 : 4)) & 0xF) : indices[i];
            const v = palette[index];
            if (format === 11 || format === 12) {
                const intensity = v >>> 8; out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = intensity; out[i * 4 + 3] = v;
            } else rgba16(v, out, i * 4);
        }
        return finishTexture(width, height, out, hasExplicitLODs ? 1 : Math.max(1, lodCount));
    }

    const format = br.read(4), width = br.read(8), height = br.read(8), compression = br.read(4);
    if (format < 0 || format >= channels.length || width === 0 || height === 0)
        throw new Error(`invalid texture ${format} ${width}x${height}`);
    const count = width * height, channelCount = channels[format], size = channelSizes[format];
    let raw: Uint16Array;
    if (compression === 2) raw = inflateHuffman(br, channelCount * count, size);
    else if (compression === 3) {
        raw = new Uint16Array(channelCount * count);
        for (let c = 0; c < channelCount; c++) raw.set(inflateHuffman(br, count, size), c * count);
    } else if (compression === 4) raw = inflateRLE(br, channelCount * count);
    else if (compression >= 5 && compression <= 7) {
        const lookup = buildLookup(br, bitsPerPixel[format]);
        let indices: Uint16Array;
        if (compression === 5) { indices = new Uint16Array(count); const n = bitSize(lookup.count); for (let i = 0; i < count; i++) indices[i] = br.read(n); }
        else if (compression === 6) indices = inflateHuffman(br, count, lookup.count);
        else indices = inflateRLE(br, count);
        const packed = new Uint32Array(count); for (let i = 0; i < count; i++) packed[i] = lookup.values[indices[i]];
        return finishTexture(width, height, packedToRGBA(format, packed, width, height), hasExplicitLODs ? 1 : Math.max(1, lodCount));
    } else if (compression === 8 || compression === 9) {
        const method = br.read(3);
        raw = compression === 8 ? inflateHuffman(br, channelCount * count, size) : inflateRLE(br, channelCount * count);
        blur(raw, width, channelCount * height, method, size);
    } else throw new Error(`unsupported texture compression ${compression}`);
    if (oneBitAlpha[format]) {
        // Alpha follows RGB rather than being included in the Huffman/RLE
        // channel count used by several formats.
        const alphaBase = count * 3;
        for (let i = 0; i < count; i++) raw[alphaBase + i] = br.read(1);
    }
    return finishTexture(width, height, rawToRGBA(format, raw, width, height), hasExplicitLODs ? 1 : Math.max(1, lodCount));
}
