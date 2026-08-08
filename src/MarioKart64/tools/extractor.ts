import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { createHash } from 'crypto';

const romPath = process.argv[2];
if (romPath === undefined)
    throw new Error('usage: node extractor.ts <Mario Kart 64 (USA).z64> [output directory]');

const outputRoot = process.argv[3] ?? './data/MarioKart64';
const rom = readFileSync(romPath);
const expectedSHA1 = '579c48e211ae952530ffc8738709f078d5dd215e';
const courseTableOffs = 0x122390;
const textureArchiveOffs = 0x641F70;
type TextureAllocation = [number, number];

const commonActorTextures: TextureAllocation[] = [
    ...[0x4CBE0, 0x4CE30, 0x4D080, 0x4D2D8, 0x4D538, 0x4D790, 0x4D9FC, 0x4DC5C].map((v) => [v, 0x400] as TextureAllocation),
    ...[0x4DEB0, 0x4E0DC, 0x4E314, 0x4E554, 0x4E798, 0x4E9F0, 0x4EC4C, 0x4EE88].map((v) => [v, 0x400] as TextureAllocation),
    ...[0x54C3C, 0x54ECC, 0x551C8, 0x554CC, 0x55880, 0x55BA0, 0x55F10, 0x561AC].map((v) => [v, 0x800] as TextureAllocation),
    [0x2FB18, 0x800], [0x35568, 0x800],
];
const piranhaTextures = [0x56408, 0x5662C, 0x5688C, 0x56AD0, 0x56CF0, 0x56EC8, 0x57084, 0x57288, 0x57590].map((v) => [v, 0x800] as TextureAllocation);
const courseActorTextures: Record<number, TextureAllocation[]> = {
    0: [[0x4F45C, 0x800], ...piranhaTextures], 2: [[0x50FCC, 0x800]], 4: [[0x4F7A4, 0x800]],
    5: [[0x513CC, 0x800], [0x51820, 0x800]], 7: [[0x4FB3C, 0x800], [0x50D50, 0x800], ...piranhaTextures],
    8: [[0x50468, 0x800], [0x50678, 0x800]],
    9: [0x4FE28, 0x50118, 0x51C54, 0x51FD8, 0x5232C, 0x526B8, 0x52A20, 0x52D3C, 0x5300C, 0x532F8, 0x5363C, 0x53950].map((v) => [v, 0x800]),
    11: [0x53C34, 0x53F74, 0x54270, 0x54518, 0x5488C].map((v) => [v, 0x800]),
    18: [[0x57EB4, 0x400], [0x581E4, 0x400], [0x58550, 0x400]],
};
const courseCloudTextures: Record<number, TextureAllocation> = {
    0: [0xD70CC, 0x1000], 4: [0xD5B14, 0x0C00], 6: [0xD690C, 0x1000], 7: [0xD6CD4, 0x1000],
    8: [0xD6418, 0x0C00], 9: [0xD5B14, 0x0C00], 11: [0xD70CC, 0x1000], 12: [0xD5F90, 0x0C00],
};

interface CourseEntry {
    segment6Start: number;
    segment6End: number;
    vertexStart: number;
    vertexEnd: number;
    textureTableStart: number;
    textureTableEnd: number;
    vertexCount: number;
    packedStart: number;
    finalDisplayListSize: number;
}

function align(n: number, amount: number): number {
    return (n + amount - 1) & ~(amount - 1);
}

function decompressMIO0(src: Buffer): Buffer {
    if (src.toString('ascii', 0, 4) !== 'MIO0')
        throw new Error('invalid MIO0 stream');
    const dst = Buffer.alloc(src.readUInt32BE(4));
    let mapOffs = 0x10, compOffs = src.readUInt32BE(8), rawOffs = src.readUInt32BE(12);
    let bits = 0, mask = 0, dstOffs = 0;
    while (dstOffs < dst.length) {
        if (mask === 0) {
            bits = src[mapOffs++];
            mask = 0x80;
        }
        if (bits & mask) {
            dst[dstOffs++] = src[rawOffs++];
        } else {
            const pair = src.readUInt16BE(compOffs);
            compOffs += 2;
            let copyOffs = dstOffs - (pair & 0x0FFF) - 1;
            for (let i = 0; i < (pair >>> 12) + 3 && dstOffs < dst.length; i++)
                dst[dstOffs++] = dst[copyOffs++];
        }
        mask >>>= 1;
    }
    return dst;
}

function readCourseEntry(courseId: number): CourseEntry {
    const offs = courseTableOffs + courseId * 0x30;
    return {
        segment6Start: rom.readUInt32BE(offs + 0x00),
        segment6End: rom.readUInt32BE(offs + 0x04),
        vertexStart: rom.readUInt32BE(offs + 0x08),
        vertexEnd: rom.readUInt32BE(offs + 0x0C),
        textureTableStart: rom.readUInt32BE(offs + 0x10),
        textureTableEnd: rom.readUInt32BE(offs + 0x14),
        vertexCount: rom.readUInt32BE(offs + 0x1C),
        packedStart: rom.readUInt32BE(offs + 0x20) & 0x00FFFFFF,
        finalDisplayListSize: rom.readUInt32BE(offs + 0x24),
    };
}

function expandCourseVertices(src: Buffer, count: number): Buffer {
    const dst = Buffer.alloc(count * 0x10);
    for (let i = 0; i < count; i++) {
        const s = i * 0x0E, d = i * 0x10;
        dst.writeInt16BE(src.readInt16BE(s + 0x00), d + 0x00);
        dst.writeInt16BE(src.readInt16BE(s + 0x02), d + 0x02);
        dst.writeInt16BE(src.readInt16BE(s + 0x04), d + 0x04);
        dst.writeUInt16BE((src[s + 0x0A] & 3) | ((src[s + 0x0B] << 2) & 0x0C), d + 0x06);
        dst.writeInt16BE(src.readInt16BE(s + 0x06), d + 0x08);
        dst.writeInt16BE(src.readInt16BE(s + 0x08), d + 0x0A);
        dst[d + 0x0C] = src[s + 0x0A] & 0xFC;
        dst[d + 0x0D] = src[s + 0x0B] & 0xFC;
        dst[d + 0x0E] = src[s + 0x0C];
        dst[d + 0x0F] = 0xFF;
    }
    return dst;
}

function extractTextures(table: Buffer): Buffer {
    const chunks: Buffer[] = [];
    for (let offs = 0; offs + 0x10 <= table.length; offs += 0x10) {
        const address = table.readUInt32BE(offs);
        if (address === 0)
            break;
        const compressedSize = table.readUInt32BE(offs + 4);
        const allocationSize = table.readUInt32BE(offs + 8);
        const texture = decompressMIO0(rom.subarray(textureArchiveOffs + (address & 0xFFFFFF), textureArchiveOffs + (address & 0xFFFFFF) + align(compressedSize, 0x10)));
        const allocation = Buffer.alloc(align(allocationSize, 0x10));
        texture.copy(allocation);
        chunks.push(allocation);
    }
    return Buffer.concat(chunks);
}

function extractTextureAllocations(entries: TextureAllocation[]): Buffer {
    return Buffer.concat(entries.map(([offset, size]) => {
        const allocation = Buffer.alloc(align(size, 0x10));
        decompressMIO0(rom.subarray(textureArchiveOffs + offset)).copy(allocation);
        return allocation;
    }));
}

function writeCommand(dst: Buffer, offs: number, w0: number, w1: number): void {
    dst.writeUInt32BE(w0 >>> 0, offs);
    dst.writeUInt32BE(w1 >>> 0, offs + 4);
}

const fixedCommands: Record<number, [number, number]> = {
    0x15: [0xFC121824, 0xFF33FFFF], 0x16: [0xFC127E24, 0xFFFFF3F9],
    0x17: [0xFCFFFFFF, 0xFFFE793C], 0x18: [0xB900031D, 0x00552078],
    0x19: [0xB900031D, 0x00553078], 0x26: [0xBB000001, 0xFFFFFFFF],
    0x27: [0xBB000000, 0x00010001], 0x2A: [0xB8000000, 0],
    0x2D: [0xBE000000, 0x000001C0], 0x2E: [0xFC127E24, 0xFFFFF3F9],
    0x2F: [0xB900031D, 0x005049D8], 0x53: [0xFC127E03, 0xFFFFF3F9],
    0x54: [0xB900031D, 0x00552078], 0x55: [0xB900031D, 0x005049D8],
    0x56: [0xB7000000, 0x00002000], 0x57: [0xB6000000, 0x00002000],
};

function unpackDisplayLists(packed: Buffer, finalSize: number): Buffer {
    const dst = Buffer.alloc(align(finalSize, 0x10) + 8);
    let p = 0, d = 0;
    const emit = (w0: number, w1: number): void => { writeCommand(dst, d, w0, w1); d += 8; };
    while (packed[p] !== 0xFF) {
        const op = packed[p++];
        if (op <= 0x14) {
            emit(0xBC000002, 0x80000040);
            emit(0x03860010, 0x09000008 + op * 0x18);
            emit(0x03880010, 0x09000000 + op * 0x18);
        } else if (fixedCommands[op] !== undefined) {
            emit(...fixedCommands[op]);
        } else if (op === 0x2B) {
            const index = packed[p++] | (packed[p++] << 8);
            emit(0x06000000, 0x07000000 + index * 8);
        } else if (op === 0x28 || (op >= 0x33 && op <= 0x52)) {
            const index = packed[p++] | (packed[p++] << 8);
            let count: number, start = 0;
            if (op === 0x28) {
                count = packed[p++] & 0x3F;
                start = packed[p++] & 0x3F;
            } else {
                count = op - 0x32;
            }
            emit(0x04000000 | (start * 2 << 16) | ((count << 10) + count * 0x10 - 1), 0x04000000 + index * 0x10);
        } else if (op === 0x29) {
            let a = packed[p++], b = packed[p++];
            const v0 = a & 0x1F, v1 = ((a >>> 5) & 7) | ((b & 3) << 3), v2 = (b >>> 2) & 0x1F;
            emit(0xBF000000, (v0 * 2 << 16) | (v1 * 2 << 8) | v2 * 2);
        } else if (op === 0x58) {
            let a = packed[p++], b = packed[p++];
            const v0 = a & 0x1F, v1 = ((a >>> 5) & 7) | ((b & 3) << 3), v2 = (b >>> 2) & 0x1F;
            a = packed[p++]; b = packed[p++];
            const v3 = a & 0x1F, v4 = ((a >>> 5) & 7) | ((b & 3) << 3), v5 = (b >>> 2) & 0x1F;
            emit(0xB1000000 | (v0 * 2 << 16) | (v1 * 2 << 8) | v2 * 2, (v3 * 2 << 16) | (v4 * 2 << 8) | v5 * 2);
        } else if (op === 0x30) {
            let a = packed[p++], b = packed[p++];
            const v1 = a & 0x1F, v2 = ((a >>> 5) & 7) | ((b & 3) << 3), v3 = (b >>> 2) & 0x1F;
            const v0 = ((b >>> 7) & 1) | ((packed[p++] & 0xF) << 1);
            emit(0xB5000000, (v0 * 2 << 24) | (v1 * 2 << 16) | (v2 * 2 << 8) | v3 * 2);
        } else if ((op >= 0x1A && op <= 0x1F) || op === 0x2C) {
            const dimensions: Record<number, [number, number, number, number]> = {
                0x1A: [32, 32, 0, 0], 0x2C: [32, 32, 0, 256], 0x1B: [64, 32, 0, 0],
                0x1C: [32, 64, 0, 0], 0x1D: [32, 32, 3, 0], 0x1E: [64, 32, 3, 0], 0x1F: [32, 64, 3, 0],
            };
            const [w, h, fmt, tmem] = dimensions[op];
            const s = packed[p++], t = packed[p++];
            emit(0xE8000000, 0);
            emit(0xF5000000 | (fmt << 21) | (2 << 19) | ((((w * 2) + 7) >>> 3) << 9) | tmem,
                ((t & 0xF) << 18) | ((t & 0xF0) >>> 4 << 14) | ((s & 0xF) << 8) | ((s & 0xF0) >>> 4 << 4));
            emit(0xF2000000, ((w - 1) << 14) | ((h - 1) << 2));
        } else if (op >= 0x20 && op <= 0x25) {
            const dimensions: [number, number, number][] = [[32, 32, 0], [64, 32, 0], [32, 64, 0], [32, 32, 3], [64, 32, 3], [32, 64, 3]];
            const [w, h, fmt] = dimensions[op - 0x20];
            const address = 0x05000000 + (packed[p++] << 11);
            p++;
            const arg = packed[p++], tmem = arg & 0xF, tile = arg >>> 4;
            emit(0xFD000000 | (fmt << 21) | (2 << 19), address);
            emit(0xE8000000, 0);
            emit(0xF5000000 | (fmt << 21) | (2 << 19) | tmem, tile << 24);
            emit(0xE6000000, 0);
            const wordsPerLine = ((w * 2) + 7) >>> 3;
            const dxt = Math.ceil((1 << 11) / wordsPerLine);
            emit(0xF3000000, (tile << 24) | (Math.min(w * h - 1, 0x7FF) << 12) | dxt);
        } else {
            throw new Error(`unsupported packed display-list opcode 0x${op.toString(16)}`);
        }
    }
    if (d > dst.length || dst.length - d > 8)
        throw new Error(`display-list size mismatch: wrote 0x${d.toString(16)}, expected 0x${dst.length.toString(16)}`);
    return dst.subarray(0, d);
}

function initializeRuntimeDisplayLists(segmentD: Buffer): void {
    const lists: [number, [number, number][]][] = [
        [0x5BAC8, [[0xB6000000, 0x00020000], [0xFD100000, 0x01004C68], [0xF5000100, 0x07000000], [0xF0000000, 0x073FC000], [0xB8000000, 0]]],
        [0x5BAF0, [[0x06000000, 0x0D007A60], [0xB6000000, 0x00002000], [0xFCFF97FF, 0xFF2DFEFF], [0xFD900000, 0x0D0293D8], [0xF5900000, 0x07080200], [0xF3000000, 0x0703F800], [0xF5800200, 0x00080200], [0xF2000000, 0x0003C03C], [0x0400103F, 0x0D005FB0], [0x06000000, 0x0D006940], [0xB8000000, 0]]],
        [0x5BB48, [[0x06000000, 0x0D007A60], [0xB6000000, 0x00002000], [0xFCFFFFFF, 0xFFFDF2F9], [0xFD900000, 0x0D000000], [0xF5900000, 0x07080200], [0xF3000000, 0x071FF200], [0xF5800800, 0x00080200], [0xF2000000, 0x000FC07C], [0x0400103F, 0x0D005FB0], [0x06000000, 0x0D006940], [0xB8000000, 0]]],
        [0x5BBA0, [[0xBB000001, 0xFFFFFFFF], [0x06000000, 0x0D001C88], [0x06000000, 0x0D001C20], [0xB8000000, 0]]],
        [0x5BBC0, [[0xBB000001, 0xFFFFFFFF], [0x06000000, 0x0D001BD8], [0x06000000, 0x0D001C20], [0xB8000000, 0]]],
    ];
    for (const [offs, commands] of lists)
        commands.forEach(([w0, w1], i) => writeCommand(segmentD, offs + i * 8, w0, w1));
}

function main(): void {
    if (rom.length !== 0xC00000 || rom.readUInt32BE(0) !== 0x80371240)
        throw new Error(`not a big-endian Mario Kart 64 USA ROM: ${romPath}`);
    const sha1 = createHash('sha1').update(rom).digest('hex');
    if (sha1 !== expectedSHA1)
        throw new Error(`unsupported ROM (SHA-1 ${sha1}); expected Mario Kart 64 (USA) ${expectedSHA1}`);
    mkdirSync(outputRoot, { recursive: true });

    const commonData = decompressMIO0(rom.subarray(0x132B50, 0x145470));
    const segmentD = Buffer.alloc(0x5C4B0);
    commonData.copy(segmentD);
    initializeRuntimeDisplayLists(segmentD);
    writeFileSync(join(outputRoot, 'Segment_D.bin'), segmentD);
    writeFileSync(join(outputRoot, 'TreeLuts.bin'), commonData);

    for (let courseId = 0; courseId < 20; courseId++) {
        const entry = readCourseEntry(courseId);
        const vertexROM = rom.subarray(entry.vertexStart, entry.vertexEnd);
        const vertices = decompressMIO0(vertexROM);
        const textureTable = rom.subarray(entry.textureTableStart, entry.textureTableEnd);
        const actorTextures = [...commonActorTextures, ...(courseActorTextures[courseId] ?? [])];
        if (courseCloudTextures[courseId] !== undefined)
            actorTextures.push(courseCloudTextures[courseId]);
        writeFileSync(join(outputRoot, `Segment_3_${courseId}.bin`), extractTextureAllocations(actorTextures));
        writeFileSync(join(outputRoot, `Segment_4_${courseId}.bin`), expandCourseVertices(vertices, entry.vertexCount));
        writeFileSync(join(outputRoot, `Segment_5_${courseId}.bin`), extractTextures(textureTable));
        writeFileSync(join(outputRoot, `Segment_6_${courseId}.bin`), decompressMIO0(rom.subarray(entry.segment6Start, entry.segment6End)));
        writeFileSync(join(outputRoot, `Segment_7_${courseId}.bin`), unpackDisplayLists(vertexROM.subarray(entry.packedStart), entry.finalDisplayListSize));
    }
    console.log(`Extracted Mario Kart 64 (USA) from ${basename(romPath)}`);
}

main();
