import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { GSPixelStorageFormat, gsMemoryMapNew, gsMemoryMapReadImagePSMT4_PSMCT32, gsMemoryMapReadImagePSMT8_PSMCT32, gsMemoryMapUploadImage } from '../Common/PS2/GS.js';
import { getVifUnpackFormatByteSize, VifCmd } from '../Common/PS2/VIF.js';

export interface PackEntry {
    x: number;
    y: number;
    data: ArrayBufferSlice;
}

function ascii(data: Uint8Array, offs: number, count: number): string {
    return String.fromCharCode(...data.subarray(offs, offs + count));
}

// Supports the original, minimal pack layout documented in VIEWER_DOC.md and
// the self-describing SOTCHP1 layout produced by the newer extractor.
export function parseHiPack(file: ArrayBufferSlice, fallbackPath: string, decompress: (src: Uint8Array) => Uint8Array): PackEntry[] {
    const bytes = file.createTypedArray(Uint8Array);
    const view = file.createDataView();
    const entries: PackEntry[] = [];

    if (ascii(bytes, 0, 8) === 'SOTCHP1\0') {
        const count = view.getUint32(0x18, true);
        const tableSize = view.getUint32(0x1C, true);
        const hashSize = view.getUint32(0x24, true);
        const payload = decompress(bytes.subarray(0x30 + tableSize));
        const stride = 0x10 + hashSize;
        for (let i = 0; i < count; i++) {
            const offs = 0x30 + i * stride;
            const x = view.getUint16(offs + 4, true);
            const y = view.getUint16(offs + 6, true);
            const payloadOffs = view.getUint32(offs + 8, true);
            const size = view.getUint32(offs + 0x0C, true);
            if (size !== 0)
                entries.push({ x, y, data: ArrayBufferSlice.fromView(payload.subarray(payloadOffs, payloadOffs + size)) });
        }
    } else {
        const match = /(\d+)-(\d+)\.bin$/.exec(fallbackPath);
        if (match === null)
            throw new Error(`Invalid SotC terrain pack path ${fallbackPath}`);
        const packY = Number(match[1]), packX = Number(match[2]);
        const sizes = Array.from({ length: 16 }, (_, i) => view.getUint32(i * 4, true));
        const payload = decompress(bytes.subarray(0x40));
        let payloadOffs = 0;
        for (let i = 0; i < 16; i++) {
            const size = sizes[i];
            if (size !== 0) {
                entries.push({
                    x: packX * 4 + i % 4, y: packY * 4 + Math.floor(i / 4),
                    data: ArrayBufferSlice.fromView(payload.subarray(payloadOffs, payloadOffs + size)),
                });
            }
            payloadOffs += size;
        }
    }
    return entries;
}

interface UnpackBatch {
    format: string;
    count: number;
    payloadOffset: number;
}

let unsupportedDrawTraceBudget = 16;

function collectVifBatches(data: DataView, start: number, size: number): UnpackBatch[] {
    const batches: UnpackBatch[] = [];
    let cursor = start, cl = 1, wl = 1;
    const end = start + size;
    const componentNames = ['S', 'V2', 'V3', 'V4'];
    const widthNames = ['32', '16', '8', '5'];
    while (cursor + 4 <= end) {
        const code = data.getUint32(cursor, true);
        cursor += 4;
        const immediate = code & 0xFFFF;
        const count = ((code >>> 16) & 0xFF) || 256;
        const command = (code >>> 24) & 0x7F;
        let payloadBytes = 0;
        if ((command & VifCmd.UNPACK_MASK) === VifCmd.UNPACK_MASK) {
            const vn = (command >>> 2) & 3, vl = command & 3;
            let sourceVectors = count;
            if (wl > cl)
                sourceVectors = Math.floor(count / wl) * cl + Math.min(count % wl, cl);
            payloadBytes = sourceVectors * getVifUnpackFormatByteSize(command & VifCmd.UNPACK_PARAM);
            batches.push({ format: `${componentNames[vn]}-${widthNames[vl]}`, count, payloadOffset: cursor });
        } else if (command === VifCmd.STCYCL) {
            cl = (immediate & 0xFF) || 256;
            wl = ((immediate >>> 8) & 0xFF) || 256;
        } else if (command === VifCmd.STMASK) {
            payloadBytes = 4;
        } else if (command === VifCmd.STROW || command === VifCmd.STCOL) {
            payloadBytes = 16;
        } else if (command === VifCmd.MPG) {
            payloadBytes = count * 8;
        } else if (command === VifCmd.DIRECT || command === VifCmd.DIRECTHL) {
            payloadBytes = immediate * 16;
        }
        // VIF payload alignment is relative to the beginning of the submitted
        // chain. The serialized model section itself is not necessarily
        // aligned within the containing sheet.
        cursor = start + (((cursor - start) + payloadBytes + 3) & ~3);
        if (cursor > end)
            break;
    }
    return batches;
}

export interface TerrainMesh {
    textureName: string | null;
    isProp: boolean;
    clampS: boolean;
    clampT: boolean;
    // Expanded triangles: position, normal, color, UV.
    vertices: Float32Array;
}

function findTaggedOffsets(bytes: Uint8Array, tag: string, stride: number): number[] {
    const needle = Array.from(tag).map((c) => c.charCodeAt(0));
    const offsets: number[] = [];
    for (let i = 3; i <= bytes.length - needle.length; i++) {
        if (needle.every((v, j) => bytes[i + j] === v) && i - 3 + stride <= bytes.length)
            offsets.push(i - 3);
    }
    return offsets;
}

function readNames(bytes: Uint8Array, start: number, end: number): string[] {
    const names: string[] = [];
    // Match the extractor's /([A-Za-z_][A-Za-z0-9_]{2,})\0/g scan.
    // Names can begin after binary bytes without a preceding NUL, so treating
    // the entire interval between two NULs as one string shifts the resource
    // indices whenever that occurs.
    for (let nul = Math.max(0, start); nul < end; nul++) {
        if (bytes[nul] !== 0)
            continue;
        let nameStart = nul;
        while (nameStart > start) {
            const c = bytes[nameStart - 1];
            const valid = c === 0x5F ||
                (c >= 0x30 && c <= 0x39) ||
                (c >= 0x41 && c <= 0x5A) ||
                (c >= 0x61 && c <= 0x7A);
            if (!valid)
                break;
            nameStart--;
        }
        if (nul - nameStart >= 3) {
            const first = bytes[nameStart];
            if (first === 0x5F || (first >= 0x41 && first <= 0x5A) || (first >= 0x61 && first <= 0x7A))
                names.push(String.fromCharCode(...bytes.subarray(nameStart, nul)));
        }
    }
    return names;
}

export function parseTerrainCell(buffer: ArrayBufferSlice): TerrainMesh[] {
    const bytes = buffer.createTypedArray(Uint8Array);
    const data = buffer.createDataView();
    const findTag = (tag: string, last = false): number => {
        const needle = Array.from(tag).map((c) => c.charCodeAt(0));
        if (last) {
            for (let i = bytes.length - needle.length; i >= 0; i--)
                if (needle.every((v, j) => bytes[i + j] === v)) return i;
        } else {
            for (let i = 0; i <= bytes.length - needle.length; i++)
                if (needle.every((v, j) => bytes[i + j] === v)) return i;
        }
        return -1;
    };
    const xff = findTag('xff\0');
    const tex = findTag('TEX\0');
    const nmo = findTag('NMO\0', true);
    if (xff < 0 || tex < 3 || nmo < 0)
        return [];

    const sectionCount = data.getUint32(xff + 0x40, true);
    const sectionTable = data.getUint32(xff + 0x5C, true);
    let modelStart = Infinity;
    for (let i = 0; i < sectionCount && i < 256; i++) {
        const d = xff + sectionTable + i * 0x20;
        if (d + 0x20 > data.byteLength) break;
        if (data.getUint32(d + 0x10, true) === 1) {
            const fileOffs = data.getUint32(d + 0x1C, true);
            if (fileOffs !== 0) modelStart = Math.min(modelStart, xff + fileOffs);
        }
    }
    if (!Number.isFinite(modelStart))
        return [];
    const drawTable = modelStart + data.getUint32(nmo + 0x60, true);
    const drawCount = data.getUint32(nmo + 0x64, true);
    if (drawCount > 100000 || drawTable + drawCount * 0x20 > data.byteLength)
        return [];

    const texRecords = findTaggedOffsets(bytes, 'TEX\0', 0x20);
    const srfRecords = findTaggedOffsets(bytes, 'SRF\0', 0x120);
    const xffNames = xff + data.getUint32(xff + 0x58, true);
    const textureNames = readNames(bytes, xffNames, tex - 3).slice(0, texRecords.length);
    const nmoNames = readNames(bytes, nmo + 4, bytes.length);
    const surfaceNames = nmoNames.slice(texRecords.length, texRecords.length + srfRecords.length);
    const pathMatch = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 0x100)))
        .match(/nmo\/[A-Za-z0-9_./-]+\.nmo/i);
    const nmoPath = pathMatch?.[0] ?? '(unknown NMO)';
    const unsupportedDraws: {
        draw: number;
        surface: string;
        chainSize: number;
        unpackSequence: string;
    }[] = [];
    const outputs = new Map<string, {
        textureName: string | null;
        isProp: boolean;
        clampS: boolean;
        clampT: boolean;
        vertices: number[];
    }>();
    for (let draw = 0; draw < drawCount; draw++) {
        const desc = drawTable + draw * 0x20;
        const surfaceIndex = data.getUint32(desc + 8, true);
        const surface = srfRecords[surfaceIndex];
        const textureIndex = surface === undefined ? -1 : data.getUint32(surface + 0x2F, true);
        const textureName = textureNames[textureIndex] ?? null;
        // The embedded GS packet words are serialized in big-endian byte
        // order. Primary CLAMP is the data word at +0x90.
        const clamp = surface === undefined ? 0 : data.getUint32(surface + 0x90, false);
        const wms = clamp & 0x03, wmt = (clamp >>> 2) & 0x03;
        const key = `${textureName ?? `__untextured_${surfaceNames[surfaceIndex] ?? surfaceIndex}`}|${wms}|${wmt}`;
        const output = outputs.get(key) ?? {
            textureName,
            // Temporary non-terrain material classification used by the
            // render-hack checkbox; this is not a decoded layout/PRF owner.
            isProp: !/^(?:world_|z_(?:iwahada|gake|rock)|ground|wall|road|cliff|mountain|water)/i
                .test(surfaceNames[surfaceIndex] ?? ''),
            clampS: wms !== 0,
            clampT: wmt !== 0,
            vertices: [],
        };
        const out = output.vertices;
        outputs.set(key, output);
        const chainSize = data.getUint32(desc, true);
        const chainStart = modelStart + data.getUint32(desc + 0x10, true);
        if (chainStart + chainSize > tex - 3) continue;
        const batches = collectVifBatches(data, chainStart, chainSize);
        let decodedThisDraw = false;
        for (let i = 0; i + 2 < batches.length; i++) {
            const h = batches[i], p = batches[i + 1];
            let nrm: UnpackBatch | null = null;
            let uv: UnpackBatch | null;
            let c: UnpackBatch;
            let batchCount: number;
            if (batches[i + 2].format === 'V4-8') {
                // Untextured/helper geometry omits the UV stream.
                uv = null;
                c = batches[i + 2];
                batchCount = 3;
            } else if (i + 4 < batches.length &&
                batches[i + 2].format === 'V3-32' &&
                (batches[i + 3].format === 'V2-16' || batches[i + 3].format === 'V4-16') &&
                batches[i + 4].format === 'V4-8') {
                // Lit geometry can provide a serialized normal for each
                // position before its UV and color streams.
                nrm = batches[i + 2];
                uv = batches[i + 3];
                c = batches[i + 4];
                batchCount = 5;
            } else if (i + 3 < batches.length) {
                uv = batches[i + 2];
                c = batches[i + 3];
                batchCount = 4;
            } else {
                continue;
            }
            if (h.format !== 'V4-32' || p.format !== 'V3-32' ||
                (uv !== null && uv.format !== 'V2-16' && uv.format !== 'V4-16') ||
                c.format !== 'V4-8' || (nrm !== null && p.count !== nrm.count) ||
                (uv !== null && p.count !== uv.count) || p.count !== c.count)
                continue;
            decodedThisDraw = true;
            const emit = (vertex: number, nx: number, ny: number, nz: number) => {
                const po = p.payloadOffset + vertex * 12;
                const co = c.payloadOffset + vertex * 4;
                const uvo = uv === null ? 0 : uv.payloadOffset + vertex * (uv.format === 'V2-16' ? 4 : 8);
                if (nrm !== null) {
                    const no = nrm.payloadOffset + vertex * 12;
                    nx = data.getFloat32(no, true);
                    ny = data.getFloat32(no + 4, true);
                    nz = -data.getFloat32(no + 8, true);
                }
                // Flip Z to move the PS2 coordinate system into noclip space.
                out.push(data.getFloat32(po, true), data.getFloat32(po + 4, true), -data.getFloat32(po + 8, true),
                    nx, ny, nz,
                    Math.min(1, data.getUint8(co) / 128), Math.min(1, data.getUint8(co + 1) / 128),
                    Math.min(1, data.getUint8(co + 2) / 128), Math.min(1, data.getUint8(co + 3) / 128),
                    uv === null ? 0 : data.getInt16(uvo, true) / 4096,
                    uv === null ? 0 : data.getInt16(uvo + 2, true) / 4096);
            };
            for (let v = 2; v < p.count; v++) {
                let a = v - 2, b = v - 1;
                if (v & 1) [a, b] = [b, a];
                const po0 = p.payloadOffset + a * 12, po1 = p.payloadOffset + b * 12, po2 = p.payloadOffset + v * 12;
                const ax = data.getFloat32(po0, true), ay = data.getFloat32(po0 + 4, true), az = -data.getFloat32(po0 + 8, true);
                const bx = data.getFloat32(po1, true), by = data.getFloat32(po1 + 4, true), bz = -data.getFloat32(po1 + 8, true);
                const cx = data.getFloat32(po2, true), cy = data.getFloat32(po2 + 4, true), cz = -data.getFloat32(po2 + 8, true);
                let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
                let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
                let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
                const length = Math.hypot(nx, ny, nz);
                if (length < 1e-6) continue;
                nx /= length; ny /= length; nz /= length;
                emit(a, nx, ny, nz); emit(b, nx, ny, nz); emit(v, nx, ny, nz);
            }
            i += batchCount - 1;
        }
        if (!decodedThisDraw) {
            unsupportedDraws.push({
                draw,
                surface: surfaceNames[surfaceIndex] ?? `surface_${surfaceIndex}`,
                chainSize,
                unpackSequence: batches.length === 0
                    ? '(no recognized UNPACK commands)'
                    : batches.slice(0, 24).map((batch) => `${batch.format}x${batch.count}`).join(' → ') +
                        (batches.length > 24 ? ` → … (+${batches.length - 24})` : ''),
            });
        }
    }
    if (unsupportedDraws.length !== 0 && unsupportedDrawTraceBudget > 0) {
        const examples = unsupportedDraws.slice(0, Math.min(4, unsupportedDrawTraceBudget));
        unsupportedDrawTraceBudget -= examples.length;
        console.warn(
            `[SotC] ${nmoPath}: ${unsupportedDraws.length}/${drawCount} draw chains had no ` +
            `supported terrain strips`,
            examples,
        );
        if (unsupportedDrawTraceBudget === 0)
            console.warn('[SotC] unsupported draw-chain trace budget exhausted; further examples are suppressed');
    }
    return [...outputs.values()].map((output) => ({
        textureName: output.textureName,
        isProp: output.isProp,
        clampS: output.clampS,
        clampT: output.clampT,
        vertices: new Float32Array(output.vertices),
    }));
}

export interface DecodedTexture {
    name: string;
    width: number;
    height: number;
    pixels: Uint8Array;
}

export function parseTexturePack(file: ArrayBufferSlice, physicalSheetCount: number, decompress: (src: Uint8Array) => Uint8Array): DecodedTexture[] {
    const bytes = file.createTypedArray(Uint8Array);
    const view = file.createDataView();
    let payload: Uint8Array;
    if (ascii(bytes, 0, 8) === 'SOTCTX1\0') {
        const tableSize = view.getUint32(0x10, true);
        payload = decompress(bytes.subarray(0x30 + tableSize));
    } else {
        payload = decompress(bytes.subarray(physicalSheetCount * 4));
    }
    const textures = new Map<string, DecodedTexture>();
    const gsMap = gsMemoryMapNew();
    const textureBasePointer = 0;
    const paletteBasePointer = 0x2000;
    for (let offset = 0; offset + 0x20 <= payload.length;) {
        if (ascii(payload, offset, 4) !== 'NTO2') { offset++; continue; }
        const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
        const pixelOffset = data.getUint32(offset + 0x14, true);
        const paletteOffset = data.getUint32(offset + 0x18, true);
        const packed = data.getUint32(offset + 0x1C, true);
        const psm = packed & 0x3F;
        const width = 1 << (data.getUint16(offset + 0x1E, true) & 0x0F);
        const height = 1 << ((packed >>> 20) & 0x0F);
        const paletteBytes = psm === 0x14 ? 0x40 : psm === 0x13 ? 0x400 : 0;
        const nameStart = offset + paletteOffset + paletteBytes;
        let nameEnd = nameStart;
        while (nameEnd < payload.length && payload[nameEnd] !== 0 && nameEnd - nameStart < 256) nameEnd++;
        if (pixelOffset < 0x20 || paletteOffset < pixelOffset || nameEnd >= payload.length) { offset += 4; continue; }
        const name = ascii(payload, nameStart, nameEnd - nameStart).replace(/\.nto$/i, '');
        const pixels = new Uint8Array(width * height * 4);
        const palette = offset + paletteOffset;
        if (psm === GSPixelStorageFormat.PSMT4 || psm === GSPixelStorageFormat.PSMT8) {
            const tbw = Math.max(1, Math.ceil(width / 64));
            const texels = ArrayBufferSlice.fromView(payload.subarray(offset + pixelOffset, offset + paletteOffset));
            // The game transfers PSMT4 payloads through a PSMCT32 host-to-local
            // transfer, then samples the resulting GS memory as PSMT4. This
            // cross-format transfer performs the characteristic 4-bit swizzle.
            if (psm === GSPixelStorageFormat.PSMT4)
                gsMemoryMapUploadImage(
                    gsMap, GSPixelStorageFormat.PSMCT32, textureBasePointer, Math.max(1, tbw >>> 1),
                    0, 0, width >>> 1, height >>> 2, texels,
                );
            else
                gsMemoryMapUploadImage(
                    gsMap, psm, textureBasePointer, tbw,
                    0, 0, width, height, texels,
                );
            const paletteWidth = psm === GSPixelStorageFormat.PSMT4 ? 8 : 16;
            const paletteHeight = psm === GSPixelStorageFormat.PSMT4 ? 2 : 16;
            gsMemoryMapUploadImage(
                gsMap, GSPixelStorageFormat.PSMCT32, paletteBasePointer, 1,
                0, 0, paletteWidth, paletteHeight,
                ArrayBufferSlice.fromView(payload.subarray(palette, palette + paletteBytes)),
            );
            if (psm === GSPixelStorageFormat.PSMT4)
                gsMemoryMapReadImagePSMT4_PSMCT32(
                    pixels, gsMap, textureBasePointer, tbw, width, height,
                    paletteBasePointer, 0, -1,
                );
            else
                gsMemoryMapReadImagePSMT8_PSMCT32(
                    pixels, gsMap, textureBasePointer, tbw, width, height,
                    paletteBasePointer, -1,
                );
        } else if (psm === GSPixelStorageFormat.PSMCT32) {
            for (let i = 0; i < width * height; i++) {
                const src = offset + pixelOffset + i * 4;
                pixels.set(payload.subarray(src, src + 4), i * 4);
                pixels[i * 4 + 3] = Math.min(0xFF, pixels[i * 4 + 3] * 2);
            }
        } else { offset = nameEnd + 1; continue; }
        if (name.length !== 0 && !textures.has(name))
            textures.set(name, { name, width, height, pixels });
        offset = nameEnd + 1;
    }
    return [...textures.values()];
}
