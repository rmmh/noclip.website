import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import { zstdCompressSync } from 'node:zlib';
import ArrayBufferSlice from '../../ArrayBufferSlice.js';
import * as BYML from '../../byml.js';

const romPath = process.argv[2];
if (romPath === undefined)
    throw new Error('usage: tsx src/SuperMario64/tools/extractor.ts <Super Mario 64 (USA).z64> [output directory]');

const outputRoot = process.argv[3] ?? './data/SuperMario64';
const rom = readFileSync(romPath);
const expectedSHA1 = '9bef1128717f958171a4afac3ed78ee2bb4e86ce';
// Linked functions in resident segment 0x15 select actor groups whose model IDs are
// reused by other groups. Locate the segment from script_func_global_10's ROM bytes.
const global10Signature = Buffer.from('220800540c000224220800550c000188', 'hex');
const global10SegmentOffset = 0x084C;
const scriptsSegmentSize = 0x0A10;
const global10RomOffset = rom.indexOf(global10Signature);
if (global10RomOffset < global10SegmentOffset)
    throw new Error('could not locate resident level-script segment');
const scriptsSegmentRomStart = global10RomOffset - global10SegmentOffset;
const scriptsSegmentRomEnd = scriptsSegmentRomStart + scriptsSegmentSize;

interface ObjectInfo { model: number; position: number[]; rotation: number[]; behavior?: number; behaviorParameter?: number; billboard?: boolean; billboardDepthOffset?: number; scale?: number; scaleXYZ?: number[]; graphYOffset?: number; motionPath?: number[][]; motionSpeed?: number; motionPathFrameStep?: number; spawnPeriod?: number; nearSpawnPeriod?: number; spawnDistanceMin?: number; spawnDistanceMax?: number; spawnOdds?: number; spawnRequiresMarioBelow?: boolean; motionRollRate?: number; trajectoryAddress?: number; activationCenter?: number[]; activeFromAfar?: boolean; birdParent?: number[]; behaviorTarget?: number[]; spawnedByTriplet?: boolean; spawnedByScuttlebugSpawner?: boolean; randomSeedOffset?: number; pokeyPartIndex?: number; chainPartIndex?: number; }
interface MarioStart { area: number; yaw: number; position: number[]; }
interface DisplayListInfo { address: number; layer: number; area?: number; }
interface MovtexInfo { kind: 'water' | 'sand' | 'lava'; vertices: number[][]; indices: number[]; alpha: number; scrollS?: number; rotation?: number; textureAddress: number; materialAddress?: number; lighting?: boolean; }
interface EnvironmentRegion { type: number; loX: number; loZ: number; hiX: number; hiZ: number; height: number; }
interface PaintingInfo { displayList: number; position: number[]; pitch: number; yaw: number; size: number; alpha: number; textureType: number; }
interface LevelInfo { id: string; name: string; displayLists: DisplayListInfo[]; segments: number[]; objects: ObjectInfo[]; movtex: MovtexInfo[]; paintings?: PaintingInfo[]; modelGeos: Record<number, number>; modelDLs: Record<number, number>; marioStart?: MarioStart; cameraMode?: number; backgroundColor?: number; }
interface LevelArchive { Segments: { ID: number; Data: ArrayBufferSlice }[]; Collision: ArrayBufferSlice; EnvironmentRegions: EnvironmentRegion[]; }

function collectCollisionTriangles(buffer: Buffer, start: number): Buffer {
    const forceSurfaces = new Set([0x04, 0x0E, 0x24, 0x25, 0x27, 0x2C, 0x2D]);
    const vertices: number[][] = [];
    const triangles: number[][] = [];
    let p = start;
    while (p + 2 <= buffer.length) {
        const command = buffer.readUInt16BE(p); p += 2;
        if (command === 0x40) {
            if (p + 2 > buffer.length) break;
            const count = buffer.readUInt16BE(p); p += 2;
            vertices.length = 0;
            for (let i = 0; i < count && p + 6 <= buffer.length; i++, p += 6)
                vertices.push([buffer.readInt16BE(p), buffer.readInt16BE(p + 2), buffer.readInt16BE(p + 4)]);
        } else if (command < 0x40 || command >= 0x65) {
            if (p + 2 > buffer.length) break;
            const count = buffer.readUInt16BE(p); p += 2;
            const stride = forceSurfaces.has(command) ? 8 : 6;
            for (let i = 0; i < count && p + stride <= buffer.length; i++, p += stride) {
                const a = vertices[buffer.readUInt16BE(p)], b = vertices[buffer.readUInt16BE(p + 2)], c = vertices[buffer.readUInt16BE(p + 4)];
                if (a === undefined || b === undefined || c === undefined) continue;
                const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
                const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
                const normalY = uz * vx - ux * vz;
                if (normalY > 0) {
                    triangles.push([...a, ...b, ...c]);
                }
            }
        } else if (command === 0x41) {
            continue;
        } else if (command === 0x42 || command === 0x43 || command === 0x44) {
            break;
        } else {
            break;
        }
    }
    const result = Buffer.allocUnsafe(triangles.length * 18);
    for (let i = 0; i < triangles.length; i++)
        for (let j = 0; j < 9; j++) result.writeInt16BE(triangles[i][j], i * 18 + j * 2);
    return result;
}

// Renderable entries from the ROM's sMacroObjectPresets. Spawner-only presets
// whose model is MODEL_NONE are expanded separately when their children are
// needed. Values are the US ROM's model ID, behavior segmented address, and
// preset second behavior-parameter byte.
const macroActorPresets = new Map<number, [number, number, number]>([
    [35, [0xDF, 0x13000528, 0]],       // Chuckya
    [38, [0xC2, 0x13003354, 0]],       // Homing Amp
    [39, [0xC2, 0x13003388, 0]],       // Circling Amp
    [43, [0xCE, 0x130051E0, 0]],       // Snufit
    [82, [0x59, 0x13001548, 0]],       // Heave-Ho
    [84, [0x58, 0x13000BC8, 0]],       // Thwomp
    [85, [0xB4, 0x1300518C, 0]],       // Fire Spitter
    [86, [0xDC, 0x130046DC, 1]],       // Fire Fly Guy
    [87, [0x81, 0x13001650, 0]],       // Jumping Box
    [93, [0x56, 0x1300362C, 0]],       // Small Bully
    [94, [0x57, 0x1300362C, 0]],       // Unused big-model Bully preset
    [108, [0x54, 0x13004918, 0]],      // Enemy Lakitu
    [125, [0x55, 0x13004F40, 0]],      // Unagi
    [151, [0x55, 0x13004A00, 0]],      // Monty Mole without rock
    [152, [0x55, 0x13004A00, 1]],      // Monty Mole
    [153, [0x54, 0x13004A58, 0]],      // Monty Mole hole
    [154, [0xDC, 0x130046DC, 0]],      // Fly Guy
    [165, [0x54, 0x130012B4, 0]],      // Spindrift
    [166, [0x55, 0x13004DBC, 0]],      // Mr. Blizzard
    [169, [0x57, 0x130020E8, 0]],      // Small Penguin
    [190, [0x56, 0x13004FD4, 0]],      // Haunted Chair
    [242, [0x69, 0x13005468, 0]],      // Skeeter
    [243, [0x58, 0x13005440, 0]],      // Clam Shell
    [253, [0x64, 0x13001FBC, 0]],      // Piranha Plant
    [255, [0x67, 0x13002BCC, 0]],      // Whomp
    [256, [0x66, 0x1300478C, 0]],      // Chain Chomp
    [258, [0x68, 0x13004580, 1]],      // Koopa
    [261, [0x64, 0x13005120, 0]],      // Fire Piranha Plant
    [262, [0x64, 0x13005120, 1]],      // Alternate Fire Piranha Plant
    [263, [0x68, 0x13004580, 4]],      // Tiny Koopa
    [281, [0x74, 0x130039D4, 0]],      // Hidden Moneybag (coin disguise)
    [289, [0x64, 0x13004698, 0]],      // Swoop
    [290, [0x64, 0x13004698, 1]],      // Alternate-room Swoop preset
    [293, [0x65, 0x13002B5C, 0]],      // Scuttlebug
]);

// Link order in the US ROM. Stub entries in level_defines.h have no segment.
const levels: [string, string][] = [
    ['bbh', "Big Boo's Haunt"], ['ccm', 'Cool, Cool Mountain'], ['castle_inside', "Peach's Castle"],
    ['hmc', 'Hazy Maze Cave'], ['ssl', 'Shifting Sand Land'], ['bob', 'Bob-omb Battlefield'],
    ['sl', "Snowman's Land"], ['wdw', 'Wet-Dry World'], ['jrb', 'Jolly Roger Bay'],
    ['thi', 'Tiny-Huge Island'], ['ttc', 'Tick Tock Clock'], ['rr', 'Rainbow Ride'],
    ['castle_grounds', 'Castle Grounds'], ['bitdw', 'Bowser in the Dark World'],
    ['vcutm', 'Vanish Cap Under the Moat'], ['bitfs', 'Bowser in the Fire Sea'],
    ['sa', 'The Secret Aquarium'], ['bits', 'Bowser in the Sky'], ['lll', 'Lethal Lava Land'],
    ['ddd', 'Dire, Dire Docks'], ['wf', "Whomp's Fortress"], ['ending', 'Ending'],
    ['castle_courtyard', 'Castle Courtyard'], ['pss', "The Princess's Secret Slide"],
    ['cotmc', 'Cavern of the Metal Cap'], ['totwc', 'Tower of the Wing Cap'],
    ['bowser_1', 'Bowser 1 Arena'], ['wmotr', 'Wing Mario Over the Rainbow'],
    ['bowser_2', 'Bowser 2 Arena'], ['bowser_3', 'Bowser 3 Arena'], ['ttm', 'Tall, Tall Mountain'],
];

function decompressMIO0(start: number, end: number): Buffer {
    const src = rom.subarray(start, end);
    if (src.toString('ascii', 0, 4) !== 'MIO0')
        throw new Error(`invalid MIO0 stream at 0x${start.toString(16)}`);
    const dst = Buffer.alloc(src.readUInt32BE(4));
    let mapOffs = 0x10, compOffs = src.readUInt32BE(8), rawOffs = src.readUInt32BE(12);
    let bits = 0, mask = 0, dstOffs = 0;
    while (dstOffs < dst.length) {
        if (mask === 0) { bits = src[mapOffs++]; mask = 0x80; }
        if (bits & mask) dst[dstOffs++] = src[rawOffs++];
        else {
            const pair = src.readUInt16BE(compOffs); compOffs += 2;
            let copyOffs = dstOffs - (pair & 0x0FFF) - 1;
            for (let i = 0; i < (pair >>> 12) + 3 && dstOffs < dst.length; i++)
                dst[dstOffs++] = dst[copyOffs++];
        }
        mask >>>= 1;
    }
    return dst;
}

function findLevelScripts(): number[] {
    const signature = Buffer.from([0x1B, 0x04, 0, 0]);
    const result: number[] = [];
    for (let offs = 0; (offs = rom.indexOf(signature, offs)) >= 0; offs++) {
        if (offs < 0x300000) continue;
        let p = offs, loadsLevelData = false;
        for (let command = 0; command < 20; command++) {
            const op = rom[p], size = rom[p + 1];
            if (size < 4 || size > 0x20 || (size & 3) !== 0) break;
            if ((op === 0x18 || op === 0x1A) && rom[p + 3] === 7) loadsLevelData = true;
            p += size;
        }
        if (loadsLevelData) result.push(offs);
    }
    return result;
}

function findCommonSegment3(): Buffer {
    for (let offs = 0; (offs = rom.indexOf('MIO0', offs)) >= 0; offs += 4) {
        try {
            const data = decompressMIO0(offs, rom.length);
            if (data.length > 0x33300 && data[0x7800] === 0xE7 && data[0x2FEE8] === 0xE7)
                return data;
        } catch (_) {
        }
    }
    throw new Error('could not locate SM64 common segment 3');
}

function findCommonSegment2(): Buffer {
    for (let offs = 0; (offs = rom.indexOf('MIO0', offs)) >= 0; offs += 4) {
        try {
            const data = decompressMIO0(offs, rom.length);
            // Segment 2 contains the 32x32 water and lava textures at these
            // segmented offsets in the US ROM.
            if (data.length === 0x18A0E && data.subarray(0x14AB8, 0x152B8).some((v) => v !== 0))
                return data;
        } catch (_) {
        }
    }
    throw new Error('could not locate SM64 segment 2');
}

function findCommonSegment16(): Buffer {
    // The resident common1 geo segment is stored raw. Its first two mist geo
    // layouts form a unique ROM signature, allowing extraction without build
    // artifacts or a hard-coded ROM file offset.
    const signature = Buffer.from('0b00000004000000180000008029d924150500000300088005000000010000000b00000004000000180000008029d92415050000030009200500000001000000', 'hex');
    const start = rom.indexOf(signature);
    if (start < 0)
        throw new Error('could not locate SM64 common geo segment 0x16');
    return Buffer.from(rom.subarray(start, start + 0x1060));
}

function collectWaterBoxes(segment7: Buffer, collisionOffset: number, collisionEnd: number, kind: 'water' | 'lava'): MovtexInfo[] {
    const result: MovtexInfo[] = [];
    const findQuad = (x1: number, z1: number, x2: number, z2: number): number | undefined => {
        for (let p = 2; p + 30 <= segment7.length; p += 2) {
            const count = segment7.readInt16BE(p - 2);
            if (count < 1 || count > 16) continue;
            const xs = [segment7.readInt16BE(p + 6), segment7.readInt16BE(p + 10), segment7.readInt16BE(p + 14), segment7.readInt16BE(p + 18)];
            const zs = [segment7.readInt16BE(p + 8), segment7.readInt16BE(p + 12), segment7.readInt16BE(p + 16), segment7.readInt16BE(p + 20)];
            if (Math.min(...xs) === x1 && Math.max(...xs) === x2 && Math.min(...zs) === z1 && Math.max(...zs) === z2)
                return p;
        }
        return undefined;
    };
    for (let p = collisionOffset; p + 6 <= collisionEnd; p += 2) {
        const command = segment7.readUInt16BE(p);
        if (command !== 0x0044) continue;
        const count = segment7.readUInt16BE(p + 2);
        const sectionEnd = p + 4 + count * 12;
        if (count === 0 || count > 64 || sectionEnd + 2 > collisionEnd || segment7.readUInt16BE(sectionEnd) !== 0x0042)
            continue;
        for (let i = 0; i < count; i++) {
            const q = p + 4 + i * 12;
            if (q + 12 > segment7.length) break;
            const id = segment7.readInt16BE(q);
            // IDs 0x32 and above are mist/haze regions, not water surfaces.
            if (id >= 0x32) continue;
            const x1 = segment7.readInt16BE(q + 2), z1 = segment7.readInt16BE(q + 4);
            const x2 = segment7.readInt16BE(q + 6), z2 = segment7.readInt16BE(q + 8);
            const y = segment7.readInt16BE(q + 10);
            const quad = findQuad(x1, z1, x2, z2);
            if (quad === undefined) continue;
            const initialRotation = segment7.readInt16BE(quad);
            const rotationSpeed = segment7.readInt16BE(quad + 2);
            const scale = segment7.readInt16BE(quad + 4);
            const coordinates = [
                [segment7.readInt16BE(quad + 6), segment7.readInt16BE(quad + 8)],
                [segment7.readInt16BE(quad + 10), segment7.readInt16BE(quad + 12)],
                [segment7.readInt16BE(quad + 14), segment7.readInt16BE(quad + 16)],
                [segment7.readInt16BE(quad + 18), segment7.readInt16BE(quad + 20)],
            ];
            const counterClockwise = segment7.readInt16BE(quad + 22) === 1;
            const alpha = segment7.readInt16BE(quad + 24) & 0xFF;
            const textureId = segment7.readInt16BE(quad + 26);
            const uvRadius = scale - 1 / 32;
            const rotationOffsets = counterClockwise ? [0, -0x4000, -0x8000, 0x4000] : [0, 0x4000, -0x8000, -0x4000];
            const vertices = coordinates.map(([x, z], vertex) => {
                const angle = (initialRotation + rotationOffsets[vertex]) * Math.PI / 0x8000;
                return [x, y, z, uvRadius * Math.sin(angle), uvRadius * Math.cos(angle)];
            });
            result.push({
                kind,
                vertices,
                indices: [0, 1, 2, 0, 2, 3], alpha,
                rotation: (counterClockwise ? rotationSpeed : -rotationSpeed) * Math.PI / 0x8000,
                textureAddress: textureId === 4 ? 0x02016AB8 : 0x02014AB8,
            });
        }
        break;
    }
    return result;
}

function collectEnvironmentRegions(segment7: Buffer, collisionOffset: number, collisionEnd: number): EnvironmentRegion[] {
    const result: EnvironmentRegion[] = [];
    for (let p = collisionOffset; p + 6 <= collisionEnd; p += 2) {
        if (segment7.readUInt16BE(p) !== 0x0044) continue;
        const count = segment7.readUInt16BE(p + 2);
        const sectionEnd = p + 4 + count * 12;
        if (count === 0 || count > 64 || sectionEnd + 2 > collisionEnd || segment7.readUInt16BE(sectionEnd) !== 0x0042)
            continue;
        for (let i = 0; i < count; i++) {
            const q = p + 4 + i * 12;
            result.push({
                type: segment7.readInt16BE(q),
                loX: segment7.readInt16BE(q + 2), loZ: segment7.readInt16BE(q + 4),
                hiX: segment7.readInt16BE(q + 6), hiZ: segment7.readInt16BE(q + 8),
                height: segment7.readInt16BE(q + 10),
            });
        }
        break;
    }
    return result;
}

function collectCastlePaintings(segment7: Buffer): PaintingInfo[] {
    // The N64 Painting structure is 0x78 bytes. Locate the complete table by
    // validating its fourteen consecutive IDs, texture types, and segmented
    // normal-display-list pointers instead of relying on a ROM file offset.
    const structSize = 0x78;
    // HMC occupies group slot 6 but uses painting ID 14 for its floor-warp
    // surface. This is the exact ordering of sInsideCastlePaintings.
    const paintingIDs = [0, 1, 2, 3, 4, 5, 14, 7, 8, 9, 10, 11, 12, 13];
    const count = paintingIDs.length;
    for (let start = 0; start + structSize * count <= segment7.length; start += 4) {
        let valid = true;
        for (let i = 0; i < count; i++) {
            const p = start + i * structSize;
            const textureType = segment7[p + 3], displayList = segment7.readUInt32BE(p + 0x58);
            if (segment7.readUInt16BE(p) !== paintingIDs[i] || textureType > 1 || displayList >>> 24 !== 0x07) {
                valid = false;
                break;
            }
        }
        if (!valid) continue;
        const result: PaintingInfo[] = [];
        for (let i = 0; i < count; i++) {
            const p = start + i * structSize;
            result.push({
                displayList: segment7.readUInt32BE(p + 0x58),
                pitch: segment7.readFloatBE(p + 0x08), yaw: segment7.readFloatBE(p + 0x0C),
                position: [segment7.readFloatBE(p + 0x10), segment7.readFloatBE(p + 0x14), segment7.readFloatBE(p + 0x18)],
                textureType: segment7[p + 3], alpha: segment7[p + 0x6D], size: segment7.readFloatBE(p + 0x74),
            });
        }
        return result;
    }
    throw new Error('castle_inside: could not locate painting table');
}

interface MovtexMeshDesc { data: number; count: number; triangles: number; colored: boolean; kind: 'sand' | 'lava' | 'water'; textureAddress: number; alpha: number; materialAddress?: number; }

function collectMovtexMesh(segment7: Buffer, desc: MovtexMeshDesc): MovtexInfo | null {
    const stride = desc.colored ? 8 : 5;
    if (desc.data + 2 + desc.count * stride * 2 > segment7.length || desc.triangles >= segment7.length) return null;
    const speed = segment7.readInt16BE(desc.data);
    const vertices: number[][] = [];
    const baseS = segment7.readInt16BE(desc.data + (desc.colored ? 14 : 8));
    const baseT = segment7.readInt16BE(desc.data + (desc.colored ? 16 : 10));
    for (let i = 0; i < desc.count; i++) {
        const p = desc.data + 2 + i * stride * 2;
        const x = segment7.readInt16BE(p), y = segment7.readInt16BE(p + 2), z = segment7.readInt16BE(p + 4);
        const colorOffset = desc.colored ? 6 : -1;
        const stOffset = desc.colored ? 12 : 6;
        const s0 = segment7.readInt16BE(p + stOffset), t0 = segment7.readInt16BE(p + stOffset + 2);
        const s = i === 0 ? s0 : baseS + s0 * 1024;
        const t = i === 0 ? t0 : baseT + t0 * 1024;
        const r = colorOffset < 0 ? 255 : segment7.readInt16BE(p + colorOffset) & 0xFF;
        const g = colorOffset < 0 ? 255 : segment7.readInt16BE(p + colorOffset + 2) & 0xFF;
        const b = colorOffset < 0 ? 255 : segment7.readInt16BE(p + colorOffset + 4) & 0xFF;
        vertices.push([x, y, z, s / 1024, t / 1024, r, g, b]);
    }
    const indices: number[] = [];
    for (let p = desc.triangles; p + 8 <= segment7.length; p += 8) {
        const command = segment7[p];
        if (command === 0xB8) break;
        const w0 = segment7.readUInt32BE(p);
        const w1 = segment7.readUInt32BE(p + 4);
        if (command === 0xBF) {
            indices.push(((w1 >>> 16) & 0xFF) / 10, ((w1 >>> 8) & 0xFF) / 10, (w1 & 0xFF) / 10);
        } else if (command === 0xB1) {
            // Fast3D's G_TRI2 packs one triangle in each command word.
            // MOVTEX triangle lists use this almost exclusively.
            indices.push(
                ((w0 >>> 16) & 0xFF) / 10, ((w0 >>> 8) & 0xFF) / 10, (w0 & 0xFF) / 10,
                ((w1 >>> 16) & 0xFF) / 10, ((w1 >>> 8) & 0xFF) / 10, (w1 & 0xFF) / 10,
            );
        }
    }
    return { kind: desc.kind, vertices, indices, alpha: desc.alpha, scrollS: speed / 1024, textureAddress: desc.textureAddress, materialAddress: desc.materialAddress, lighting: desc.colored };
}

function collectMovtexMeshes(id: string, area: number | undefined, segment7: Buffer): MovtexInfo[] {
    const descs: MovtexMeshDesc[] = [];
    if (id === 'ssl' && area === 1) {
        descs.push(
            { data: 0x127F0, count: 12, triangles: 0x128B8, colored: true, kind: 'sand', textureAddress: 0x07004018, alpha: 0xFF, materialAddress: 0x070127E0 },
            { data: 0x12900, count: 16, triangles: 0x12A08, colored: true, kind: 'sand', textureAddress: 0x07004018, alpha: 0xFF, materialAddress: 0x070127E0 },
            { data: 0x12A50, count: 15, triangles: 0x12B48, colored: true, kind: 'sand', textureAddress: 0x07004018, alpha: 0xFF, materialAddress: 0x070127E0 },
        );
    } else if (id === 'ssl' && area === 2) {
        descs.push(
            { data: 0x28760, count: 8, triangles: 0x287B8, colored: false, kind: 'sand', textureAddress: 0x07001000, alpha: 0xFF, materialAddress: 0x070286A0 },
            { data: 0x287F0, count: 8, triangles: 0x287B8, colored: false, kind: 'sand', textureAddress: 0x07001000, alpha: 0xFF, materialAddress: 0x070285F0 },
            { data: 0x28844, count: 6, triangles: 0x28888, colored: false, kind: 'sand', textureAddress: 0x07001000, alpha: 0xFF, materialAddress: 0x070286A0 },
        );
    } else if (id === 'lll' && area === 1) {
        descs.push({ data: 0x286BC, count: 9, triangles: 0x28718, colored: false, kind: 'lava', textureAddress: 0x02016AB8, alpha: 0xC8 });
    } else if (id === 'bitfs') {
        descs.push(
            { data: 0x15AF0, count: 4, triangles: 0x15BA8, colored: false, kind: 'lava', textureAddress: 0x02016AB8, alpha: 0xFF },
            { data: 0x15B1C, count: 4, triangles: 0x15BA8, colored: false, kind: 'lava', textureAddress: 0x02016AB8, alpha: 0xB4 },
            { data: 0x15B48, count: 9, triangles: 0x15BC0, colored: false, kind: 'lava', textureAddress: 0x02016AB8, alpha: 0xB4 },
        );
    } else if (id === 'castle_grounds') {
        descs.push({ data: 0x11750, count: 15, triangles: 0x117E8, colored: false, kind: 'water', textureAddress: 0x02014AB8, alpha: 0xB4 });
    } else if (id === 'cotmc') {
        descs.push({ data: 0x0BED0, count: 14, triangles: 0x0BF60, colored: false, kind: 'water', textureAddress: 0x02014AB8, alpha: 0xB4 });
    } else if (id === 'ttm') {
        descs.push(
            { data: 0x17134, count: 6, triangles: 0x17260, colored: false, kind: 'water', textureAddress: 0x02014AB8, alpha: 0xB4 },
            { data: 0x171A0, count: 6, triangles: 0x17260, colored: false, kind: 'water', textureAddress: 0x02014AB8, alpha: 0xB4 },
            { data: 0x17174, count: 4, triangles: 0x17288, colored: false, kind: 'water', textureAddress: 0x02014AB8, alpha: 0xB4 },
            { data: 0x171E0, count: 4, triangles: 0x17288, colored: false, kind: 'water', textureAddress: 0x02014AB8, alpha: 0xB4 },
            { data: 0x1720C, count: 8, triangles: 0x172A0, colored: false, kind: 'water', textureAddress: 0x02014AB8, alpha: 0xB4 },
        );
    }
    return descs.map((desc) => collectMovtexMesh(segment7, desc)).filter((surface): surface is MovtexInfo => surface !== null);
}

function instanceMovtex(surface: MovtexInfo, object: ObjectInfo): MovtexInfo {
    const yaw = object.rotation[1] * Math.PI / 180;
    const sinY = Math.sin(yaw), cosY = Math.cos(yaw);
    return {
        ...surface,
        vertices: surface.vertices.map((vertex) => [
            object.position[0] + vertex[0] * cosY + vertex[2] * sinY,
            object.position[1] + vertex[1],
            object.position[2] - vertex[0] * sinY + vertex[2] * cosY,
            ...vertex.slice(3),
        ]),
        indices: [...surface.indices],
    };
}

function readTrajectory(segment7: Buffer, address: number): number[][] {
    const result: number[][] = [];
    for (let p = address & 0x00FFFFFF; p + 8 <= segment7.length; p += 8) {
        if (segment7.readInt16BE(p) === -1) break;
        result.push([segment7.readInt16BE(p + 2), segment7.readInt16BE(p + 4), segment7.readInt16BE(p + 6)]);
    }
    return result;
}

function findROMTrajectory(first: number[][]): number[][] {
    const signature = Buffer.alloc(first.length * 8);
    for (let i = 0; i < first.length; i++) {
        signature.writeInt16BE(i, i * 8);
        signature.writeInt16BE(first[i][0], i * 8 + 2);
        signature.writeInt16BE(first[i][1], i * 8 + 4);
        signature.writeInt16BE(first[i][2], i * 8 + 6);
    }
    const start = rom.indexOf(signature);
    if (start < 0) throw new Error('could not locate resident bowling-ball trajectory');
    const result: number[][] = [];
    for (let p = start; p + 8 <= rom.length; p += 8) {
        if (rom.readInt16BE(p) === -1) break;
        result.push([rom.readInt16BE(p + 2), rom.readInt16BE(p + 4), rom.readInt16BE(p + 6)]);
    }
    return result;
}

const thiLargeBowlingPath = findROMTrajectory([[-4786, 101, -2166], [-5000, 81, -2753]]);
const thiSmallBowlingPath = findROMTrajectory([[-1476, 29, -680], [-1492, 14, -1072]]);

// bhvBigBoulder starts at the HMC generator and follows the cave floor until it
// drops below the level. These points are sampled from hmc_seg7_collision_level
// along the generator's forward centerline; object_step_without_floor_orient
// supplies this gravity-and-floor profile in the original game.
const hmcBigBoulderPath = [
    [-6093, 3075, -7807], [-6093, 2451, -7327], [-6093, 1792, -6847],
    [-6093, 1658, -6367], [-6093, 1600, -5887], [-6093, 1552, -5407],
    [-6093, 1536, -4927], [-6093, 1536, -4447], [-6093, 1485, -3967],
    [-6093, 1389, -3487], [-6093, 1331, -3007], [-6093, 1331, -2527],
    [-6093, 1331, -2047], [-6093, 1211, -1567], [-6093, 585, -1087],
    [-6093, -423, -607], [-6093, -1359, -367],
];

function collectAreaGeo(segmentBase: number, starts: number[]): { displayLists: Map<number, number>; cameraMode?: number; backgroundColor?: number } {
    const result = new Map<number, number>();
    let cameraMode: number | undefined;
    let backgroundColor: number | undefined;
    const active = new Set<number>();
    const walk = (start: number): void => {
        if (active.has(start)) return;
        active.add(start);
        for (let p = segmentBase + start; p + 4 <= rom.length;) {
            const op = rom[p], param = rom[p + 1];
            let size = 4, dlOffset = -1;
            if (op === 0x00 || op === 0x02) {
                const target = rom.readUInt32BE(p + 4);
                if ((target >>> 24) === 0x0E) walk(target & 0x00FFFFFF);
                p += 8;
                if (op === 0x02 && param === 0) break;
                continue;
            } else if (op === 0x01 || op === 0x03) break;
            else if (op === 0x08) size = 12;
            else if (op === 0x0A) size = param !== 0 ? 12 : 8;
            else if (op === 0x0D || op === 0x0E || op === 0x16 || op === 0x18 || op === 0x19 || op === 0x1A || op === 0x1E) size = 8;
            else if (op === 0x0F) {
                size = 20;
                cameraMode ??= rom.readUInt16BE(p + 2);
            }
            else if (op === 0x10) {
                const layout = param & 0x70;
                size = layout === 0 ? 16 : layout === 0x30 ? 4 : 8;
                if (param & 0x80) { dlOffset = size; size += 4; }
            } else if (op === 0x11 || op === 0x12 || op === 0x14) {
                size = 8;
                if (param & 0x80) { dlOffset = 8; size = 12; }
            } else if (op === 0x13) { size = 12; dlOffset = 8; }
            else if (op === 0x15) { size = 8; dlOffset = 4; }
            else if (op === 0x1C) size = 12;
            else if (op === 0x1D) {
                size = 8;
                if (param & 0x80) { dlOffset = 8; size = 12; }
            } else if (op === 0x1F) size = 16;
            else if (op > 0x20) break;
            // A null function pointer makes GEO_BACKGROUND's parameter an
            // RGBA5551 fill color rather than a panorama ID.
            if (op === 0x19 && rom.readUInt32BE(p + 4) === 0)
                backgroundColor ??= rom.readUInt16BE(p + 2);
            if (dlOffset >= 0) {
                const dl = rom.readUInt32BE(p + dlOffset);
                if ((dl >>> 24) === 7) result.set(dl, param & 0x0F);
            }
            p += size;
        }
        active.delete(start);
    };
    for (const start of starts) walk(start);
    return { displayLists: result, cameraMode, backgroundColor };
}

function findModelGeos(segments: Set<number>): Record<number, number> {
    const result: Record<number, number> = {};
    for (let p = 0; p + 8 <= rom.length; p += 4) {
        if (rom[p] !== 0x22 || rom[p + 1] !== 8) continue;
        const model = rom.readUInt16BE(p + 2), geo = rom.readUInt32BE(p + 4);
        if (model > 0xFF || !segments.has(geo >>> 24)) continue;
        result[model] = geo;
    }
    return result;
}

function findModelDLs(segments: Set<number>): Record<number, number> {
    const result: Record<number, number> = {};
    for (let p = 0; p + 8 <= rom.length; p += 4) {
        if (rom[p] !== 0x21 || rom[p + 1] !== 8) continue;
        const model = rom.readUInt16BE(p + 2) & 0x0FFF, dl = rom.readUInt32BE(p + 4);
        if (model <= 0xFF && segments.has(dl >>> 24)) result[model] = dl;
    }
    return result;
}

function collectLinkedScripts(levelId: string, segmentData: Map<number, Buffer>, starts: number[], objects: ObjectInfo[], modelGeos: Record<number, number>, modelDLs: Record<number, number>): void {
    const visited = new Set<number>();
    const objectKeys = new Set(objects.map((o) => `${o.model}:${o.position.join(',')}:${o.rotation.join(',')}`));
    const walk = (address: number): void => {
        if (visited.has(address)) return;
        visited.add(address);
        const buffer = segmentData.get(address >>> 24);
        if (buffer === undefined) return;
        for (let p = address & 0x00FFFFFF; p + 4 <= buffer.length;) {
            const op = buffer[p], size = buffer[p + 1];
            if (size < 4 || (size & 3) !== 0 || p + size > buffer.length) break;
            if (op === 0x06 && size === 8) walk(buffer.readUInt32BE(p + 4));
            else if (op === 0x22 && size === 8) {
                const model = buffer.readUInt16BE(p + 2), geo = buffer.readUInt32BE(p + 4);
                if (model <= 0xFF && segmentData.has(geo >>> 24)) modelGeos[model] = geo;
            } else if (op === 0x21 && size === 8) {
                const model = buffer.readUInt16BE(p + 2) & 0x0FFF, dl = buffer.readUInt32BE(p + 4);
                if (model <= 0xFF && segmentData.has(dl >>> 24)) modelDLs[model] = dl;
            } else if (op === 0x24 && size === 0x18 && (buffer[p + 2] & 1) !== 0) {
                const model = buffer[p + 3];
                const position = [buffer.readInt16BE(p + 4), buffer.readInt16BE(p + 6), buffer.readInt16BE(p + 8)];
                const behavior = buffer.readUInt32BE(p + 20);
                if (levelId === 'bbh' && behavior === 0x130053F4) {
                    const coffinPositions = [[412, -150], [762, -150], [1112, -150], [412, 150], [762, 150], [1112, 150]];
                    for (let coffinIndex = 0; coffinIndex < coffinPositions.length; coffinIndex++) {
                        const [x, z] = coffinPositions[coffinIndex];
                        const child: ObjectInfo = { model: 0x3C, position: [position[0] + x, position[1], position[2] + z], rotation: [0, z > 0 ? 180 : 0, 0], behavior: 0x13005414, behaviorParameter: coffinIndex & 1, scaleXYZ: [1, 1.1, 1] };
                        const childKey = `${child.model}:${child.position.join(',')}:${child.rotation.join(',')}`;
                        if (!objectKeys.has(childKey)) { objectKeys.add(childKey); objects.push(child); }
                    }
                }
                if (levelId === 'ssl' && behavior === 0x130052B4) {
                    const hands: ObjectInfo[] = [
                        { model: 0x58, position: [position[0] - 224, position[1], position[2] + 300], rotation: [0, 90, 0], behavior: 0x130052D0, behaviorParameter: 0xFF, scaleXYZ: [-1.5, 1.5, 1.5] },
                        { model: 0x59, position: [position[0] + 224, position[1], position[2] + 300], rotation: [0, -90, 0], behavior: 0x130052D0, behaviorParameter: 1, scaleXYZ: [1.5, 1.5, 1.5] },
                    ];
                    for (const hand of hands) {
                        const handKey = `${hand.model}:${hand.position.join(',')}:${hand.rotation.join(',')}`;
                        if (!objectKeys.has(handKey)) { objectKeys.add(handKey); objects.push(hand); }
                    }
                }
                const bowlingSpawner = behavior === 0x13003AA4 || behavior === 0x13003A80 || behavior === 0x13003AC8;
                const bigBoulderSpawner = levelId === 'hmc' && behavior === 0x13003DA0;
                const renderModel = model !== 0 ? model : bowlingSpawner ? 0xB4 : bigBoulderSpawner ? 0x39 : behavior === 0x13000054 ? 0x67 : 0;
                if (renderModel !== 0) {
                    const rotation = [buffer.readInt16BE(p + 10), buffer.readInt16BE(p + 12), buffer.readInt16BE(p + 14)];
                    const key = `${renderModel}:${position.join(',')}:${rotation.join(',')}`;
                    if (!objectKeys.has(key)) {
                        objectKeys.add(key);
                        const parameter = (buffer.readUInt32BE(p + 16) >>> 16) & 0xFF;
                        const scale = bigBoulderSpawner ? 1.5 : behavior === 0x13000054 ? parameter + 1 : renderModel === 0xC0 ? [1.5, 3.5, 0.5][parameter & 0x03] : renderModel === 0x67 && parameter !== 0 ? 2 : undefined;
                        const graphYOffset = bigBoulderSpawner ? 270 : renderModel === 0xB4 ? parameter === 4 ? 39 : 130 : undefined;
                        const billboard = renderModel === 0xB4 || behavior === 0x13000054 ? true : undefined;
                        const trajectoryAddress = bowlingSpawner ? (levelId === 'bob' ? (parameter === 2 ? 0x070115C4 : 0x07011530) : levelId === 'ttm' ? 0x070170A0 : undefined) : undefined;
                        const motionPath = bigBoulderSpawner ? hmcBigBoulderPath : behavior === 0x13003AC8 ? parameter === 4 ? thiSmallBowlingPath : thiLargeBowlingPath : undefined;
                        const spawnDistanceMax = !bowlingSpawner ? undefined : parameter === 0 ? 7000 : parameter === 1 ? 8000 : parameter === 2 ? 6000 : 12000;
                        const spawnOdds = !bowlingSpawner ? undefined : parameter === 1 ? 1 : parameter <= 2 ? 2 : 1.5;
                        objects.push({ model: renderModel, position, rotation, behavior, behaviorParameter: parameter, scale: behavior === 0x13003AC8 && parameter === 4 ? 0.3 : scale, graphYOffset, billboard, trajectoryAddress, motionPath, motionSpeed: bigBoulderSpawner ? 40 : motionPath !== undefined ? parameter === 4 ? 10 : 25 : trajectoryAddress === undefined ? undefined : levelId === 'ttm' ? 10 : 20, motionPathFrameStep: bigBoulderSpawner ? 12 : undefined, spawnPeriod: bigBoulderSpawner ? 128 : motionPath !== undefined ? 64 : trajectoryAddress === undefined ? undefined : levelId === 'ttm' ? 64 : 128, nearSpawnPeriod: bigBoulderSpawner ? 64 : undefined, spawnDistanceMin: bigBoulderSpawner ? 1500 : bowlingSpawner ? levelId === 'thi' ? 800 : 1000 : undefined, spawnDistanceMax, spawnOdds, spawnRequiresMarioBelow: bowlingSpawner || undefined, motionRollRate: bigBoulderSpawner ? 40 * (100 / 1.5) : undefined });
                    }
                }
            }
            if (op === 0x07 || op === 0x02 || op === 0x1C) break;
            p += size;
        }
    };
    for (const start of starts) walk(start);
}

function expandCoinFormation(objects: ObjectInfo[], preset: number, x: number, y: number, z: number, yaw: number): void {
    const angle = yaw * Math.PI / 180;
    const add = (dx: number, dy: number, dz: number): void => {
        const rx = dx * Math.cos(angle) + dz * Math.sin(angle);
        const rz = -dx * Math.sin(angle) + dz * Math.cos(angle);
        objects.push({ model: 0x74, position: [x + rx, y + dy, z + rz], rotation: [0, yaw, 0], billboard: true });
    };
    if (preset === 6 || preset === 9) {
        for (let i = -2; i <= 2; i++) add(i * 300, 0, 0);
    } else if (preset === 7 || preset === 11) {
        for (let i = 0; i < 8; i++) add(Math.cos(i * Math.PI / 4) * 300, 0, Math.sin(i * Math.PI / 4) * 300);
    } else if (preset === 12) {
        for (let i = 0; i < 8; i++) add(Math.cos(i * Math.PI / 4) * 300, Math.sin(i * Math.PI / 4) * 300, 0);
    }
}

function main(): void {
    if (rom.length !== 0x800000 || rom.readUInt32BE(0) !== 0x80371240)
        throw new Error(`not a big-endian Super Mario 64 USA ROM: ${romPath}`);
    const sha1 = createHash('sha1').update(rom).digest('hex');
    if (sha1 !== expectedSHA1)
        throw new Error(`unsupported ROM (SHA-1 ${sha1}); expected Super Mario 64 (USA) ${expectedSHA1}`);

    const scripts = findLevelScripts();
    if (scripts.length !== levels.length)
        throw new Error(`found ${scripts.length} level scripts, expected ${levels.length}`);
    mkdirSync(outputRoot, { recursive: true });
    const commonSegment3 = findCommonSegment3();
    const commonSegment2 = findCommonSegment2();
    const commonSegment16 = findCommonSegment16();
    const manifest: LevelInfo[] = [];

    for (let i = 0; i < scripts.length; i++) {
        const [id, name] = levels[i];
        const scriptStart = scripts[i];
        const segmentData = new Map<number, Buffer>();
        segmentData.set(0x15, Buffer.from(rom.subarray(scriptsSegmentRomStart, scriptsSegmentRomEnd)));
        const areaGeoLayouts: { area: number; offset: number }[] = [];
        const objects: ObjectInfo[] = [];
        const macroLists: number[] = [];
        const jumpLinks: number[] = [];
        const collisionByArea = new Map<number, number>();
        const explicitModelGeos: Record<number, number> = {};
        const explicitModelDLs: Record<number, number> = {};
        let marioStart: MarioStart | undefined;
        let levelSegmentBase = -1;
        let currentArea = 0;
        for (let p = scriptStart; p < rom.length;) {
            const op = rom[p], size = rom[p + 1];
            if (size < 4 || (size & 3) !== 0) break;
            if (op === 0x17 || op === 0x18 || op === 0x1A) {
                const segment = rom[p + 3];
                const start = rom.readUInt32BE(p + 4), end = rom.readUInt32BE(p + 8);
                segmentData.set(segment, op === 0x17 ? Buffer.from(rom.subarray(start, end)) : decompressMIO0(start, end));
                if (segment === 7) levelSegmentBase = end;
            }
            if (op === 0x1F) {
                currentArea = rom[p + 2];
                const geo = rom.readUInt32BE(p + 4);
                if ((geo >>> 24) === 0x0E) areaGeoLayouts.push({ area: rom[p + 2], offset: geo & 0x00FFFFFF });
            }
            if (op === 0x20) currentArea = 0;
            if (op === 0x2E && size === 8 && currentArea !== 0) {
                const collision = rom.readUInt32BE(p + 4);
                if ((collision >>> 24) === 7) collisionByArea.set(currentArea, collision & 0x00FFFFFF);
            }
            if (op === 0x06 && size === 8) jumpLinks.push(rom.readUInt32BE(p + 4));
            if (op === 0x22 && size === 8) explicitModelGeos[rom.readUInt16BE(p + 2)] = rom.readUInt32BE(p + 4);
            if (op === 0x21 && size === 8) explicitModelDLs[rom.readUInt16BE(p + 2) & 0x0FFF] = rom.readUInt32BE(p + 4);
            if (op === 0x24 && size === 0x18) {
                const scriptModel = rom[p + 3];
                const behavior = rom.readUInt32BE(p + 20);
                if (id === 'bbh' && behavior === 0x130053F4) {
                    const parentX = rom.readInt16BE(p + 4), parentY = rom.readInt16BE(p + 6), parentZ = rom.readInt16BE(p + 8);
                    const coffinPositions = [[412, -150], [762, -150], [1112, -150], [412, 150], [762, 150], [1112, 150]];
                    for (let coffinIndex = 0; coffinIndex < coffinPositions.length; coffinIndex++) {
                        const [x, z] = coffinPositions[coffinIndex];
                        objects.push({
                            model: 0x3C,
                            position: [parentX + x, parentY, parentZ + z],
                            rotation: [0, z > 0 ? 180 : 0, 0],
                            behavior: 0x13005414,
                            behaviorParameter: coffinIndex & 1,
                            scaleXYZ: [1, 1.1, 1],
                        });
                    }
                }
                if (id === 'ssl' && behavior === 0x130052B4) {
                    const parentX = rom.readInt16BE(p + 4), parentY = rom.readInt16BE(p + 6), parentZ = rom.readInt16BE(p + 8);
                    // The sleeping boss immediately spawns both hands. Their
                    // sleep action offsets each hand 724 units back across its
                    // 500-unit spawn-relative home position.
                    objects.push(
                        { model: 0x58, position: [parentX - 224, parentY, parentZ + 300], rotation: [0, 90, 0], behavior: 0x130052D0, behaviorParameter: 0xFF, scaleXYZ: [-1.5, 1.5, 1.5] },
                        { model: 0x59, position: [parentX + 224, parentY, parentZ + 300], rotation: [0, -90, 0], behavior: 0x130052D0, behaviorParameter: 1, scaleXYZ: [1.5, 1.5, 1.5] },
                    );
                }
                if (behavior === 0x13001B54) {
                    // Castle aquarium tank groups spawn fifteen blue fish at a
                    // rotated (300, 0, -200) offset, randomized within 200.
                    const originX = rom.readInt16BE(p + 4), originY = rom.readInt16BE(p + 6), originZ = rom.readInt16BE(p + 8);
                    const yaw = rom.readInt16BE(p + 12), yawRadians = yaw * Math.PI / 180;
                    // spawn_object_relative transforms local offsets with
                    // mtxf_rotate_zxy_and_translate's SM64 yaw convention.
                    const baseX = originX + Math.cos(yawRadians) * 300 + Math.sin(yawRadians) * -200;
                    const baseZ = originZ - Math.sin(yawRadians) * 300 + Math.cos(yawRadians) * -200;
                    for (let fishIndex = 0; fishIndex < 15; fishIndex++) {
                        const phase = fishIndex * 2.399963229728653 + originX * 0.001 + originZ * 0.002;
                        const radius = 30 + (fishIndex * 47) % 200;
                        objects.push({
                            model: 0xB9,
                            position: [baseX + Math.sin(phase) * radius, originY + ((fishIndex * 83) % 400) - 200, baseZ + Math.cos(phase) * radius],
                            rotation: [0, yaw + fishIndex * 24, 0],
                            behavior: 0x13001B2C,
                            behaviorParameter: 0,
                            activationCenter: [originX, originY, originZ],
                        });
                    }
                }
                const bowlingSpawner = behavior === 0x13003AA4 || behavior === 0x13003A80 || behavior === 0x13003AC8;
                const bigBoulderSpawner = id === 'hmc' && behavior === 0x13003DA0;
                const model = scriptModel !== 0 ? scriptModel : bowlingSpawner ? 0xB4 : bigBoulderSpawner ? 0x39 : behavior === 0x13000054 ? 0x67 : 0;
                if (model !== 0) {
                    const parameter = (rom.readUInt32BE(p + 16) >>> 16) & 0xFF;
                    const scale = bigBoulderSpawner ? 1.5 : behavior === 0x13000054 ? parameter + 1 : model === 0xC0 ? [1.5, 3.5, 0.5][parameter & 0x03] : model === 0x67 && parameter !== 0 ? 2 : undefined;
                    const graphYOffset = bigBoulderSpawner ? 270 : model === 0xB4 ? parameter === 4 ? 39 : 130 : undefined;
                    const billboard = model === 0xB4 || behavior === 0x13000054 ? true : undefined;
                    const trajectoryAddress = bowlingSpawner ? (id === 'bob' ? (parameter === 2 ? 0x070115C4 : 0x07011530) : id === 'ttm' ? 0x070170A0 : undefined) : undefined;
                    const motionPath = bigBoulderSpawner ? hmcBigBoulderPath : behavior === 0x13003AC8 ? parameter === 4 ? thiSmallBowlingPath : thiLargeBowlingPath : undefined;
                    const spawnDistanceMax = !bowlingSpawner ? undefined : parameter === 0 ? 7000 : parameter === 1 ? 8000 : parameter === 2 ? 6000 : 12000;
                    const spawnOdds = !bowlingSpawner ? undefined : parameter === 1 ? 1 : parameter <= 2 ? 2 : 1.5;
                    objects.push({ model, position: [rom.readInt16BE(p + 4), rom.readInt16BE(p + 6), rom.readInt16BE(p + 8)], rotation: [rom.readInt16BE(p + 10), rom.readInt16BE(p + 12), rom.readInt16BE(p + 14)], behavior, behaviorParameter: parameter, scale: behavior === 0x13003AC8 && parameter === 4 ? 0.3 : scale, graphYOffset, billboard, trajectoryAddress, motionPath, motionSpeed: bigBoulderSpawner ? 40 : motionPath !== undefined ? parameter === 4 ? 10 : 25 : trajectoryAddress === undefined ? undefined : id === 'ttm' ? 10 : 20, motionPathFrameStep: bigBoulderSpawner ? 12 : undefined, spawnPeriod: bigBoulderSpawner ? 128 : motionPath !== undefined ? 64 : trajectoryAddress === undefined ? undefined : id === 'ttm' ? 64 : 128, nearSpawnPeriod: bigBoulderSpawner ? 64 : undefined, spawnDistanceMin: bigBoulderSpawner ? 1500 : bowlingSpawner ? id === 'thi' ? 800 : 1000 : undefined, spawnDistanceMax, spawnOdds, spawnRequiresMarioBelow: bowlingSpawner || undefined, motionRollRate: bigBoulderSpawner ? 40 * (100 / 1.5) : undefined });
                }
            }
            if (op === 0x2B && size === 0x0C) {
                marioStart = {
                    area: rom[p + 2],
                    yaw: rom.readInt16BE(p + 4),
                    position: [rom.readInt16BE(p + 6), rom.readInt16BE(p + 8), rom.readInt16BE(p + 10)],
                };
            }
            if (op === 0x39 && size === 8) {
                const pointer = rom.readUInt32BE(p + 4);
                if ((pointer >>> 24) === 7) macroLists.push(pointer & 0x00FFFFFF);
            }
            if (op === 0x1C || op === 0x02) break;
            p += size;
        }

        let displayLists = new Map<number, number>();
        let areaDisplayLists: DisplayListInfo[] | undefined;
        let cameraMode: number | undefined;
        let backgroundColor: number | undefined;
        if (levelSegmentBase < 0) throw new Error(`${id}: missing segment 7 load`);
        const nextCompressedSegment = rom.indexOf('MIO0', levelSegmentBase);
        const rawSegmentEnd = nextCompressedSegment >= 0 ? nextCompressedSegment : Math.min(rom.length, scriptStart + 0x10000);
        segmentData.set(0x0E, Buffer.from(rom.subarray(levelSegmentBase, rawSegmentEnd)));
        collectLinkedScripts(id, segmentData, jumpLinks, objects, explicitModelGeos, explicitModelDLs);
        if (areaGeoLayouts.length > 0) {
            // Peach's Castle is split into three level-script areas: main
            // floor, upper floors, and basement. Objects and paintings from
            // all three are intentionally retained for the combined noclip
            // view, so traverse their corresponding original geo roots too.
            const entryLayouts = id === 'castle_inside' || marioStart === undefined
                ? areaGeoLayouts : areaGeoLayouts.filter((layout) => layout.area === marioStart.area);
            if (id === 'castle_inside') {
                areaDisplayLists = [];
                for (const layout of entryLayouts) {
                    const areaGeo = collectAreaGeo(levelSegmentBase, [layout.offset]);
                    for (const [address, layer] of areaGeo.displayLists)
                        areaDisplayLists.push({ address, layer, area: layout.area });
                    cameraMode ??= areaGeo.cameraMode;
                    backgroundColor ??= areaGeo.backgroundColor;
                }
            } else {
                const areaGeo = collectAreaGeo(levelSegmentBase, entryLayouts.map((layout) => layout.offset));
                displayLists = areaGeo.displayLists;
                cameraMode = areaGeo.cameraMode;
                backgroundColor = areaGeo.backgroundColor;
            }
        }

        const segments = [...segmentData.keys()].sort((a, b) => a - b);
        if (!segmentData.has(3)) { segmentData.set(3, commonSegment3); segments.unshift(3); }
        if (!segmentData.has(2)) { segmentData.set(2, commonSegment2); segments.unshift(2); }
        if (!segmentData.has(0x16)) { segmentData.set(0x16, commonSegment16); segments.push(0x16); }
        const segment7 = segmentData.get(7)!;
        for (const object of objects) {
            if (object.trajectoryAddress !== undefined) {
                object.motionPath = readTrajectory(segment7, object.trajectoryAddress);
                delete object.trajectoryAddress;
            }
        }
        const selectedArea = marioStart?.area ?? areaGeoLayouts[0]?.area;
        const collisionOffset = selectedArea === undefined ? undefined : collisionByArea.get(selectedArea);
        const collisionEnd = collisionOffset === undefined ? undefined : [...collisionByArea.values()].filter((offset) => offset > collisionOffset).sort((a, b) => a - b)[0] ?? segment7.length;
        const collisionTriangles = collisionOffset === undefined ? Buffer.alloc(0) : collectCollisionTriangles(segment7, collisionOffset);
        const environmentRegions = collisionOffset === undefined || collisionEnd === undefined ? [] : collectEnvironmentRegions(segment7, collisionOffset, collisionEnd);
        const waterKind = id === 'lll' && selectedArea === 2 ? 'lava' : 'water';
        const movtex = collisionOffset === undefined || collisionEnd === undefined ? [] : collectWaterBoxes(segment7, collisionOffset, collisionEnd, waterKind);
        const paintings = id === 'castle_inside' ? collectCastlePaintings(segment7) : undefined;
        movtex.push(...collectMovtexMeshes(id, selectedArea, segment7));
        // Collision special-object lists contain static level geometry, trees, doors, and props.
        // Records have preset-dependent lengths; level-geometry presets include a byte-angle yaw.
        for (let p = 0; p + 4 <= segment7.length; p += 2) {
            if (segment7.readUInt16BE(p) !== 0x0043) continue;
            const count = segment7.readUInt16BE(p + 2);
            if (count === 0 || count > 256) continue;
            let q = p + 4;
            const found: ObjectInfo[] = [];
            let valid = true;
            for (let i = 0; i < count; i++) {
                if (q + 8 > segment7.length) { valid = false; break; }
                const preset = segment7.readUInt16BE(q);
                const x = segment7.readInt16BE(q + 2), y = segment7.readInt16BE(q + 4), z = segment7.readInt16BE(q + 6);
                let size = 8, yaw = 0;
                if (preset >= 0x83 && preset <= 0x88) {
                    size = 12;
                    if (q + size > segment7.length) { valid = false; break; }
                    yaw = segment7.readInt16BE(q + 8) * 360 / 256;
                } else if ((preset >= 0x65 && preset <= 0x78) || preset >= 0x7E || preset === 0 || preset === 8 || preset === 14 || preset === 35 || preset === 36) {
                    size = 10;
                    if (q + size > segment7.length) { valid = false; break; }
                    yaw = segment7.readInt16BE(q + 8) * 360 / 256;
                } else if (preset === 30) {
                    size = 14;
                } else if (preset > 0x90) {
                    valid = false; break;
                }
                if (preset >= 0x65 && preset <= 0x78)
                    found.push({ model: preset - 0x62, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 29)
                    found.push({ model: 0xB3, position: [x, y, z], rotation: [0, 0, 0], behavior: 0x130037EC, behaviorParameter: 0 });
                else if (preset === 33)
                    found.push({ model: 0x64, position: [x, y, z], rotation: [0, 0, 0], behavior: 0x13001850, behaviorParameter: 0 });
                else if (preset >= 0x79 && preset <= 0x7D)
                    // special_bubble_tree through special_palm_tree map to the
                    // actual level model table IDs 0x17..0x1B. bhvTree applies
                    // billboarding; it is not part of the tree geo layout.
                    found.push({ model: preset - 0x62, position: [x, y, z], rotation: [0, 0, 0], billboard: true });
                q += size;
            }
            // A real special section is followed by COL_WATER_BOX_INIT or COL_END.
            if (valid && q + 2 <= segment7.length) {
                const nextCommand = segment7.readUInt16BE(q);
                valid = nextCommand === 0x0042 || nextCommand === 0x0044;
            }
            if (valid) objects.push(...found);
        }
        if (id === 'ssl' && selectedArea === 1) {
            const pit = collectMovtexMesh(segment7, { data: 0x04930, count: 8, triangles: 0x04A38, colored: true, kind: 'sand', textureAddress: 0x07004018, alpha: 0xFF, materialAddress: 0x07004818 });
            if (pit !== null)
                for (const object of objects.filter((object) => object.model === 3)) movtex.push(instanceMovtex(pit, object));
        } else if (id === 'ssl' && selectedArea === 2) {
            const pit = collectMovtexMesh(segment7, { data: 0x049B4, count: 8, triangles: 0x04A38, colored: true, kind: 'sand', textureAddress: 0x07001000, alpha: 0xFF, materialAddress: 0x07004880 });
            if (pit !== null)
                for (const object of objects.filter((object) => object.model === 4)) movtex.push(instanceMovtex(pit, object));
        }
        for (const listOffset of macroLists) {
            for (let p = listOffset; p + 10 <= segment7.length; p += 10) {
                const header = segment7.readInt16BE(p);
                if (header === 0x1E || header === -1) break;
                const preset = (header & 0x1FF) - 31;
                const yaw = ((header >>> 9) & 0x7F) * 360 / 128;
                const x = segment7.readInt16BE(p + 2), y = segment7.readInt16BE(p + 4), z = segment7.readInt16BE(p + 6);
                if (preset === 0 || preset === 1 || preset === 5)
                    objects.push({ model: 0x74, position: [x, y, z], rotation: [0, yaw, 0], billboard: true });
                else if (preset === 4)
                    objects.push({ model: 0xD7, position: [x, y, z], rotation: [0, yaw, 0], billboard: true });
                else if (preset === 22)
                    objects.push({ model: 0xC9, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 21)
                    // wooden_signpost_geo contains GEO_SCALE(0.25); applying a
                    // second object scale here shrinks the sign to 1/16 size.
                    objects.push({ model: 0x7C, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 30 || preset === 31 || preset === 37)
                    objects.push({ model: 0xC0, position: [x, y, z], rotation: [0, yaw, 0], behavior: 0x1300472C, scale: preset === 30 ? 3.5 : preset === 31 ? 0.5 : 1.5 });
                else if (preset === 32) {
                    // bhvGoombaTripletSpawner uses a 500-unit circle with one
                    // child every 0x5555 binang, rotated by the spawner yaw.
                    for (let child = 0; child < 3; child++) {
                        const angle = yaw * Math.PI / 180 + child * Math.PI * 2 / 3;
                        objects.push({ model: 0xC0, position: [x + Math.cos(angle) * 500, y, z + Math.sin(angle) * 500], rotation: [0, yaw, 0], behavior: 0x1300472C, scale: 1.5, activationCenter: [x, y, z], spawnedByTriplet: true });
                    }
                } else if (preset === 27 || preset === 239) {
                    // The two used "few" fish spawners create five children.
                    // Keep the ROM's 700-unit random-translation bound, but use
                    // stable phases so repeated extraction is deterministic.
                    const model = preset === 27 ? 0xB9 : 0x67;
                    for (let i = 0; i < 5; i++) {
                        const phase = i * 2.399963229728653 + x * 0.001 + z * 0.002;
                        const radius = 180 + i * 95;
                        objects.push({
                            model,
                            position: [x + Math.sin(phase) * radius, y + ((i * 283) % 700) - 350, z + Math.cos(phase) * radius],
                            rotation: [0, yaw + i * 72, 0],
                            behavior: 0x13002160,
                            behaviorParameter: preset === 27 ? 1 : 3,
                            activationCenter: [x, y, z],
                            activeFromAfar: id === 'sa',
                        });
                    }
                } else if (preset === 36)
                    objects.push({ model: 0x80, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 44)
                    objects.push({ model: 0x78, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 53)
                    objects.push({ model: 0x8C, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 73)
                    objects.push({ model: 0xCF, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 106)
                    objects.push({ model: 0x6B, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 114)
                    objects.push({ model: 0x80, position: [x, y, z], rotation: [0, yaw, 0], behavior: 0x13004F10, behaviorParameter: 0 });
                else if (preset === 111 || preset === 115)
                    objects.push({ model: 0xBC, position: [x, y, z], rotation: [0, yaw, 0], behavior: 0x13003174, behaviorParameter: preset === 115 ? 1 : 0 });
                else if (preset >= 60 && preset <= 68)
                    objects.push({ model: 0x89, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 69 || preset === 70 || (preset >= 74 && preset <= 77))
                    objects.push({ model: 0x81, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 71)
                    objects.push({ model: 0xD9, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 72)
                    objects.push({ model: 0x82, position: [x, y, z], rotation: [0, yaw, 0] });
                else if (preset === 88 || preset === 89) {
                    // bhvTripletButterfly's hidden parent creates children
                    // with spawn-type parameters one and two. Preserve the
                    // no-bombs flag from macro preset 89 on every member.
                    const flags = preset === 89 ? 4 : 0;
                    for (let butterflyIndex = 0; butterflyIndex < 3; butterflyIndex++)
                        objects.push({
                            model: 0xBB,
                            position: [x, y, z],
                            rotation: [0, yaw, 0],
                            behavior: 0x13005598,
                            behaviorParameter: flags | butterflyIndex,
                            randomSeedOffset: butterflyIndex,
                        });
                }
                else if (preset === 292)
                    // bhvScuttlebugSpawn is model-less and creates one child
                    // after its 30-frame delay when Mario is 500..1500 away.
                    objects.push({ model: 0x65, position: [x, y, z], rotation: [0, yaw, 0], behavior: 0x13002B5C, behaviorParameter: 0, spawnedByScuttlebugSpawner: true });
                else if (preset === 291) {
                    objects.push({ model: 0x67, position: [x, y, z], rotation: [0, yaw, 0], behavior: 0x13000054, behaviorParameter: 0, billboard: true });
                }
                else if (preset === 139 || preset === 140) {
                    // bhvPokey is model-less and creates five scale-3 parts,
                    // ordered from the head down to the bottom body segment.
                    for (let partIndex = 0; partIndex < 5; partIndex++) {
                        objects.push({
                            model: partIndex === 0 ? 0x54 : 0x55,
                            position: [x, y, z],
                            rotation: [0, yaw, 0],
                            behavior: partIndex === 0 ? 0x13004634 : undefined,
                            behaviorParameter: 0,
                            scale: 3,
                            graphYOffset: 66,
                            billboard: true,
                            pokeyPartIndex: partIndex,
                        });
                    }
                }
                else {
                    const actor = macroActorPresets.get(preset);
                    if (actor !== undefined)
                        objects.push({ model: actor[0], position: [x, y, z], rotation: [0, yaw, 0], behavior: actor[1], behaviorParameter: actor[2] });
                    else
                        expandCoinFormation(objects, preset, x, y, z, yaw);
                }
            }
        }
        // Water-bomb cannons create their barrel as a child object at the base position.
        for (const cannon of objects.filter((object) => object.model === 0x80))
            objects.push({ model: 0x7F, position: [...cannon.position], rotation: [...cannon.rotation], behavior: cannon.behavior, behaviorParameter: cannon.behaviorParameter });
        // jumping_box_free_update replaces the preset model with the standard
        // breakable box and applies cur_obj_scale(0.5) on every free frame.
        for (const box of objects.filter((object) => object.behavior === 0x13001650))
            box.scale = 0.5;
        // Haunted chairs only begin their autonomous rocking when init finds
        // a Mad Piano within 300 units. Preserve that actual parent lookup so
        // the two unparented macro chairs remain level until Mario activates them.
        const pianos = objects.filter((object) => object.behavior === 0x13005024);
        for (const chair of objects.filter((object) => object.behavior === 0x13004FD4)) {
            const piano = pianos.find((candidate) => Math.hypot(candidate.position[0] - chair.position[0], candidate.position[2] - chair.position[2]) < 300);
            if (piano !== undefined) chair.behaviorTarget = [...piano.position];
        }
        // Enemy Lakitu is usually a macro object. His cloud is created only
        // when he first activates, then remains parented to him permanently.
        for (const lakitu of objects.filter((object) => object.behavior === 0x13004918 && object.model === 0x54))
            objects.push({ model: 0x8E, position: [...lakitu.position], rotation: [0, 0, 0], behavior: lakitu.behavior, behaviorParameter: 0, scale: 2 });
        // bhvChainChomp owns a permanently visible wooden post and creates
        // four metallic chain links when its hidden parent activates.
        for (const chomp of objects.filter((object) => object.behavior === 0x1300478C)) {
            chomp.scale = 2;
            chomp.graphYOffset = 240;
            chomp.chainPartIndex = 0;
            objects.push({ model: 0x6B, position: [...chomp.position], rotation: [...chomp.rotation], scale: 0.5 });
            for (let chainPartIndex = 1; chainPartIndex <= 4; chainPartIndex++)
                objects.push({ model: 0x65, position: [...chomp.position], rotation: [0, 0, 0], scale: 2, graphYOffset: 40, billboard: true, chainPartIndex });
        }
        // A placed bhvBird is a hidden spawner which creates six more birds on
        // activation. Pre-create those children and retain the parent position
        // as a stable renderer-side group key.
        for (const bird of objects.filter((object) => object.behavior === 0x13005354 && object.behaviorParameter === 1)) {
            for (let child = 0; child < 6; child++)
                objects.push({ model: bird.model, position: [...bird.position], rotation: [...bird.rotation], behavior: 0x13005354, behaviorParameter: 0, birdParent: [...bird.position], randomSeedOffset: child + 1 });
        }
        // bhvMrI changes its MODEL_NONE parent to the eyeball and spawns the
        // camera-facing iris 100 scaled units in front of it.
        for (const eye of objects.filter((object) => object.behavior === 0x13000054))
            objects.push({ model: 0x66, position: [...eye.position], rotation: [...eye.rotation], billboard: true, billboardDepthOffset: 100 * (eye.scale ?? 1), scale: eye.scale });
        if (id === 'castle_inside') {
            const shiftPosition = (position: number[]): void => {
                if (position[1] > 1000) position[1] += 2000;
                else if (position[1] < -500) position[1] -= 2000;
            };
            for (const object of objects) {
                // script_func_local_2 is linked exclusively from AREA(2), but
                // this entrance pair sits below the general area-2 Y heuristic.
                if (object.model === 0x25 && object.behavior === 0x13000AFC && object.position[1] === 512 && object.position[2] === 3021)
                    object.position[1] += 2000;
                else
                    shiftPosition(object.position);
                if (object.activationCenter !== undefined) shiftPosition(object.activationCenter);
                if (object.behaviorTarget !== undefined) shiftPosition(object.behaviorTarget);
                if (object.birdParent !== undefined) shiftPosition(object.birdParent);
                if (object.motionPath !== undefined)
                    for (const point of object.motionPath) shiftPosition(point);
            }
            if (paintings !== undefined) {
                for (let painting = 0; painting < paintings.length; painting++) {
                    if (painting >= 8) paintings[painting].position[1] += 2000;
                    else if (painting >= 4) paintings[painting].position[1] -= 2000;
                }
            }
        }
        // bhvCourtyardBooTriplet has no rendered model of its own. With the
        // viewer's all-placements presentation, expand its three ROM-relative
        // Ghost Hunt Boo children directly.
        for (let i = objects.length - 1; i >= 0; i--) {
            const spawner = objects[i];
            if (spawner.behavior !== 0x130027D0) continue;
            objects.splice(i, 1);
            for (const [dx, dy, dz] of [[0, 50, 0], [210, 110, 210], [-210, 70, -210]])
                objects.push({ model: spawner.model, position: [spawner.position[0] + dx, spawner.position[1] + dy, spawner.position[2] + dz], rotation: [...spawner.rotation], behavior: 0x13002804, behaviorParameter: 1 });
        }
        const archive: LevelArchive = {
            Segments: segments.map((segment) => ({
                ID: segment,
                Data: ArrayBufferSlice.fromView(segmentData.get(segment)!),
            })),
            Collision: ArrayBufferSlice.fromView(collisionTriangles),
            EnvironmentRegions: environmentRegions,
        };
        const archiveData = BYML.write(archive, BYML.FileType.CRG1);
        writeFileSync(join(outputRoot, `${id}.crg1`), zstdCompressSync(new Uint8Array(archiveData)));
        const modelGeos = { ...findModelGeos(new Set(segments)), ...explicitModelGeos };
        const modelDLs = { ...findModelDLs(new Set(segments)), ...explicitModelDLs };
        manifest.push({ id, name, displayLists: areaDisplayLists ?? [...displayLists].map(([address, layer]) => ({ address, layer })), segments, objects, movtex, paintings, modelGeos, modelDLs, marioStart, cameraMode, backgroundColor });
    }
    writeFileSync(join(outputRoot, 'manifest.json'), JSON.stringify(manifest));
    console.log(`Extracted ${manifest.length} Super Mario 64 levels from ${basename(romPath)}`);
}

main();
