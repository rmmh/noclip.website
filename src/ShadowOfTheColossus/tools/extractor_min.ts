#!/usr/bin/env node

// SotC stores the world split into a 60x60 grid of individual levels.
// They are duplicated in horizontal and vertical strips for better disc
// streaming, and additionally in two LODs. 
//
// The low LOD is only ~40% smaller than the high LOD, so this extractor
// just packs the high LODs into 4x4 chunks (15x15 total), ~270KB each.

import { mkdirSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants as zlibConstants, zstdCompressSync } from 'node:zlib';

const ISO_SECTOR_SIZE = 2048;
const PVD_SECTOR = 16;
const ZSTD_LEVEL = 22;
const ZSTD_OPTIONS = {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: ZSTD_LEVEL },
};

type FileRef = {
    byteSize: number;
    isoOffset: number;
};

type WorldIndex = {
    name: string;
    hiRefs: FileRef[];
};

type TextureIndex = {
    logicalIdMap: number[];
    commonRefs: FileRef[];
};

class RandomAccessFile {
    readonly fd: number;

    constructor(path: string) {
        this.fd = openSync(path, 'r');
    }

    read(offset: number, byteLength: number): Buffer {
        const dst = Buffer.allocUnsafe(byteLength);
        let done = 0;
        while (done < byteLength) {
            const count = readSync(this.fd, dst, done, byteLength - done, offset + done);
            done += count;
        }
        return dst;
    }

}

class NicoReader {
    cursor = 0;
    readonly isoBase: number;
    private readonly file: RandomAccessFile;

    constructor(file: RandomAccessFile, isoBase: number) {
        this.file = file;
        this.isoBase = isoBase;
    }

    bytes(byteLength: number): Buffer {
        const value = this.file.read(this.isoBase + this.cursor, byteLength);
        this.cursor += byteLength;
        return value;
    }

    u16(): number {
        return this.bytes(2).readUInt16LE(0);
    }

    u32(): number {
        return this.bytes(4).readUInt32LE(0);
    }

    skip(byteLength: number): void {
        this.cursor += byteLength;
    }

    fileRef(): FileRef {
        const sector = this.u32();
        const byteSize = this.u32();
        const nicoOffset = sector * ISO_SECTOR_SIZE;
        return { byteSize, isoOffset: this.isoBase + nicoOffset };
    }
}

function findNico(file: RandomAccessFile): number {
    const pvd = file.read(PVD_SECTOR * ISO_SECTOR_SIZE, ISO_SECTOR_SIZE);
    const rootRecordLength = pvd[156];
    const rootRecord = pvd.subarray(156, 156 + rootRecordLength);
    const rootSector = rootRecord.readUInt32LE(2);
    const rootSize = rootRecord.readUInt32LE(10);
    const directory = file.read(rootSector * ISO_SECTOR_SIZE, rootSize);

    for (let cursor = 0; cursor < directory.length;) {
        const recordLength = directory[cursor];
        if (recordLength === 0) {
            cursor = Math.ceil((cursor + 1) / ISO_SECTOR_SIZE) * ISO_SECTOR_SIZE;
            continue;
        }
        const nameLength = directory[cursor + 32];
        const name = directory.toString('ascii', cursor + 33, cursor + 33 + nameLength);
        if (name.replace(/;[0-9]+$/, '').toUpperCase() === 'NICO.DAT')
            return directory.readUInt32LE(cursor + 2) * ISO_SECTOR_SIZE;
        cursor += recordLength;
    }
    return 0;
}

function splitNullStrings(data: Buffer): string[] {
    const strings: string[] = [];
    let start = 0;
    for (let i = 0; i < data.length; i++) {
        if (data[i] === 0) {
            strings.push(data.toString('ascii', start, i));
            start = i + 1;
        }
    }
    return strings;
}

function readRefs(reader: NicoReader, count: number): FileRef[] {
    return Array.from({ length: count }, () => reader.fileRef());
}

function parseNicoIndex(file: RandomAccessFile, nicoOffset: number): {
    textures: TextureIndex;
    world: WorldIndex;
} {
    const reader = new NicoReader(file, nicoOffset);
    for (let i = 0; i < 4; i++)
        reader.u32();
    const segmentCount = reader.u32();
    const stringPoolSize = reader.u32();
    const segmentNames = splitNullStrings(reader.bytes(stringPoolSize));

    let textures: TextureIndex;
    for (let i = 0; i < segmentCount; i++) {
        const logicalIdCount = reader.u32();
        const logicalIdMap = Array.from({ length: logicalIdCount }, () => reader.u16());
        const commonRefCount = reader.u32();
        const localizedRefCount = reader.u32();
        if (segmentNames[i] === 'stagetexseg_def') {
            const commonRefs = readRefs(reader, commonRefCount);
            reader.skip(localizedRefCount * 8);
            textures = { logicalIdMap, commonRefs };
        } else {
            reader.skip((commonRefCount + localizedRefCount) * 8);
        }
    }

    reader.u32(); // world_count == 1 on release discs
    const nameByteSize = reader.u32();
    const rawName = reader.bytes(nameByteSize);
    const nul = rawName.indexOf(0);
    const name = rawName.toString('ascii', 0, nul < 0 ? rawName.length : nul);
    const counts = [reader.u32(), reader.u32(), reader.u32()];
    let hiRefs: FileRef[] = [];
    for (let countIndex = 0; countIndex < 3; countIndex++) {
        for (let blockType = 0; blockType < 2; blockType++) {
            if (countIndex === 2 && blockType === 0)
                hiRefs = readRefs(reader, counts[countIndex]);
            else
                reader.skip(counts[countIndex] * 8);
        }
    }

    return { textures: textures!, world: { name, hiRefs } };
}

const HI_PACK_SIDE = 4;
const HI_PACK_INDEX_SIZE = HI_PACK_SIDE * HI_PACK_SIDE * 4;

function writeHiPacks(
    source: RandomAccessFile,
    outDir: string,
    world: WorldIndex,
) {
    const packDir = join(outDir, 'hi');
    mkdirSync(packDir, { recursive: true });
    const groups = new Map<string, { levelIndex: number; ref: FileRef }[]>();
    for (let levelIndex = 0; levelIndex < world.hiRefs.length; levelIndex++) {
        const ref = world.hiRefs[levelIndex];
        if (ref.byteSize === 12 && source.read(ref.isoOffset, 4).readUInt32LE(0) === 0)
            continue;  // some levels are empty, drop them
        const x = levelIndex % 60;
        const y = Math.floor(levelIndex / 60);
        const key =
            `${Math.floor(y / HI_PACK_SIDE).toString().padStart(2, '0')}-` +
            `${Math.floor(x / HI_PACK_SIDE).toString().padStart(2, '0')}`;
        const levels = groups.get(key) ?? [];
        levels.push({ levelIndex, ref });
        groups.set(key, levels);
    }

    const packs: string[] = [];
    let byteSize = 0;
    for (const [name, levels] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
        levels.sort((a, b) => a.levelIndex - b.levelIndex);
        const entries = Buffer.alloc(HI_PACK_INDEX_SIZE);
        const payloads: Buffer[] = [];
        for (const level of levels) {
            const payload = source.read(level.ref.isoOffset, level.ref.byteSize);
            const x = level.levelIndex % 60;
            const y = Math.floor(level.levelIndex / 60);
            const slot = (y % HI_PACK_SIDE) * HI_PACK_SIDE + x % HI_PACK_SIDE;
            entries.writeUInt32LE(payload.length, slot * 4);
            payloads.push(payload);
        }

        const storedPayload = zstdCompressSync(Buffer.concat(payloads), ZSTD_OPTIONS);
        const packed = Buffer.concat([entries, storedPayload]);
        const fileName = `${name}.bin`;
        const path = join(packDir, fileName);
        writeFileSync(path, packed);
        packs.push(`hi/${fileName}`);
        byteSize += packed.length;
    }
    return { packs, byteSize };
}

function writeTexturePack(
    source: RandomAccessFile,
    outDir: string,
    textures: TextureIndex,
) {
    const refs = textures.commonRefs;
    const entries = Buffer.alloc(refs.length * 4);
    const payloads: Buffer[] = [];
    for (let physicalIndex = 0; physicalIndex < refs.length; physicalIndex++) {
        const ref = refs[physicalIndex];
        const payload = source.read(ref.isoOffset, ref.byteSize);
        entries.writeUInt32LE(payload.length, physicalIndex * 4);
        payloads.push(payload);
    }
    const storedPayload = zstdCompressSync(Buffer.concat(payloads), ZSTD_OPTIONS);
    const packed = Buffer.concat([entries, storedPayload]);
    const fileName = 'stage-textures.sotct';
    const path = join(outDir, fileName);
    writeFileSync(path, packed);
    return {
        file: fileName,
        logicalIdMap: textures.logicalIdMap,
        byteSize: packed.length,
    };
}

function main(): void {
    const args = process.argv.slice(2);
    if (args.length !== 2) {
        console.error('Usage: node extractor_min.ts <game.iso> <destdir>');
        process.exit(1);
    }
    const [isoPath, outDir] = args;
    const file = new RandomAccessFile(isoPath);
    const index = parseNicoIndex(file, findNico(file));

    mkdirSync(outDir, { recursive: true });
    const levels = writeHiPacks(file, outDir, index.world);
    const textures = writeTexturePack(file, outDir, index.textures);

    const manifest = {
        format: 'sotc-viewer-pack-manifest-v1',
        grid: {
            width: 60,
            height: 60,
            packSide: HI_PACK_SIDE,
        },
        worlds: [{ name: index.world.name, packs: levels.packs }],
        textures: {
            file: textures.file,
            logicalIdMap: textures.logicalIdMap,
        },
    };
    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    console.log(
        `Wrote ${(levels.byteSize / 1_000_000).toFixed(2)} MB of levels and ` +
        `${(textures.byteSize / 1_000_000).toFixed(2)} MB of textures`,
    );
}

main();
