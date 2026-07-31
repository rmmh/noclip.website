import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { GSPixelStorageFormat, gsMemoryMapNew, gsMemoryMapReadImagePSMT4_PSMCT32, gsMemoryMapReadImagePSMT8_PSMCT32, gsMemoryMapUploadImage } from '../Common/PS2/GS.js';
import { getVifUnpackFormatByteSize, VifCmd } from '../Common/PS2/VIF.js';
import { mat3, mat4, quat, vec3 } from 'gl-matrix';
import { relocateLegacyXff, type RelocatedXff } from './xff.js';

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
    address: number;
    unsigned: boolean;
    masked: boolean;
    cycleCL: number;
    cycleWL: number;
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
            batches.push({
                format: `${componentNames[vn]}-${widthNames[vl]}`,
                count,
                // The microcode uses XTOP as the base; these are offsets into
                // that double-buffered input block. Bit 15 selects TOPS and
                // bit 14 is the UNPACK unsigned flag.
                address: immediate & 0x03FF,
                unsigned: (immediate & 0x4000) !== 0,
                masked: (command & 0x10) !== 0,
                cycleCL: cl,
                cycleWL: wl,
                payloadOffset: cursor,
            });
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
    sourceName: string;
    textureName: string | null;
    secondaryTextureName: string | null;
    isProp: boolean;
    isLayer1: boolean;
    isSpecialLayer: boolean;
    isTranslucent: boolean;
    isWater: boolean;
    hasWaterEffect: boolean;
    gsAlpha: number;
    gsAlphaFix: number;
    disableCull: boolean;
    clampS: boolean;
    clampT: boolean;
    secondaryClampS: boolean;
    secondaryClampT: boolean;
    // Expanded triangles: position, normal, color, primary UV, secondary UV.
    vertices: Float32Array;
    // Present for deformable six-stream prop packets. These are expanded in
    // the same triangle-list order as vertices and retained for animation.
    skinningControl?: Uint8Array;
    deformationData?: Uint32Array;
    // Slow-object models are instantiated directly by initSlowObject. Unlike
    // ordinary StageLayout instances, they do not receive either the
    // StageLayout transform or the enclosing coarse-cell origin.
    stagePlacement?: 'direct';
}

function transformMesh(mesh: TerrainMesh, matrix: mat4): TerrainMesh {
    const vertices = mesh.vertices.slice();
    const p = vec3.create(), n = vec3.create();
    const normalMatrix = mat3.normalFromMat4(mat3.create(), matrix);
    for (let i = 0; i < vertices.length; i += 14) {
        vec3.set(p, vertices[i], vertices[i + 1], vertices[i + 2]);
        vec3.transformMat4(p, p, matrix);
        vertices[i] = p[0]; vertices[i + 1] = p[1]; vertices[i + 2] = p[2];
        vec3.set(n, vertices[i + 3], vertices[i + 4], vertices[i + 5]);
        if (normalMatrix !== null)
            vec3.transformMat3(n, n, normalMatrix);
        vec3.normalize(n, n);
        vertices[i + 3] = n[0]; vertices[i + 4] = n[1]; vertices[i + 5] = n[2];
    }
    return { ...mesh, isProp: true, vertices };
}

interface SheetSegmentEntry {
    path: string;
    payloadStart: number;
    payloadSize: number;
}

// Mirrors MANAGER.XFF__SheetSegmentLoad: a primary XFF2 directory followed by
// optional per-sheet secondary resource blocks.
function parseSheetSegmentEntries(bytes: Uint8Array): SheetSegmentEntry[] {
    const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (data.byteLength < 4)
        throw new Error('Truncated sheet-segment header');
    const entryCount = data.getUint32(0, true);
    const directoryEnd = 4 + entryCount * 0x10;
    if (entryCount > 0x10000 || directoryEnd > data.byteLength)
        throw new Error('Invalid sheet-segment directory');
    const entries: SheetSegmentEntry[] = [];
    const directoryEntries = Array.from({ length: entryCount }, (_, index) => {
        const directory = 4 + index * 0x10;
        return {
            primarySize: data.getUint32(directory + 0x08, true),
            secondarySize: data.getUint32(directory + 0x0C, true),
        };
    });
    let entryStart = directoryEnd;
    for (let index = 0; index < entryCount; index++) {
        const entrySize = directoryEntries[index].primarySize;
        if (entrySize < 8 || entryStart + entrySize > data.byteLength)
            throw new Error(`Invalid sheet-segment entry ${index} size`);
        const pathSize = data.getUint32(entryStart, true);
        const payloadSize = data.getUint32(entryStart + 4, true);
        const payloadStart = entryStart + 8 + pathSize;
        if (pathSize === 0 || bytes[payloadStart - 1] !== 0 ||
            8 + pathSize + payloadSize > entrySize)
            throw new Error(`Invalid sheet-segment entry ${index} payload`);
        entries.push({
            path: ascii(bytes, entryStart + 8, pathSize - 1),
            payloadStart,
            payloadSize,
        });
        entryStart += entrySize;
    }
    for (let index = 0; index < entryCount; index++) {
        const blockSize = directoryEntries[index].secondarySize;
        if (blockSize === 0)
            continue;
        const blockEnd = entryStart + blockSize;
        if (entryStart + 8 > data.byteLength || blockEnd > data.byteLength)
            throw new Error(`Invalid sheet-segment resource block ${index}`);
        const resourceCount = data.getUint32(entryStart, true);
        const groupNameSize = data.getUint32(entryStart + 4, true);
        entryStart += 8;
        if (groupNameSize === 0 || entryStart + groupNameSize > blockEnd ||
            bytes[entryStart + groupNameSize - 1] !== 0)
            throw new Error(`Invalid sheet-segment resource group ${index}`);
        entryStart += groupNameSize;
        for (let resource = 0; resource < resourceCount; resource++) {
            if (entryStart + 0x10 > blockEnd)
                throw new Error(`Invalid sheet-segment resource ${index}:${resource}`);
            const pathSize = data.getUint32(entryStart + 8, true);
            const payloadSize = data.getUint32(entryStart + 0x0C, true);
            entryStart += 0x10;
            const payloadStart = entryStart + pathSize;
            if (pathSize === 0 || payloadStart + payloadSize > blockEnd ||
                bytes[payloadStart - 1] !== 0)
                throw new Error(`Invalid sheet-segment resource payload ${index}:${resource}`);
            entries.push({
                path: ascii(bytes, entryStart, pathSize - 1),
                payloadStart,
                payloadSize,
            });
            entryStart = payloadStart + payloadSize;
        }
        if (entryStart !== blockEnd)
            throw new Error(`Sheet-segment resource block ${index} size mismatch`);
    }
    return entries;
}

function readSrfGsRegister(data: DataView, surface: number, wantedAddress: number): bigint | null {
    const end = Math.min(data.byteLength, surface + 0xC0);
    for (let cursor = surface + 0x60; cursor + 4 <= end;) {
        const code = data.getUint32(cursor, true);
        cursor += 4;
        const command = code >>> 24 & 0x7F;
        const immediate = code & 0xFFFF;
        if (command !== VifCmd.DIRECT && command !== VifCmd.DIRECTHL)
            continue;
        const directEnd = Math.min(end, cursor + immediate * 0x10);
        while (cursor + 0x10 <= directEnd) {
            const loops = data.getUint32(cursor, true) & 0x7FFF;
            const tag1 = data.getUint32(cursor + 4, true);
            const format = tag1 >>> 26 & 3;
            const registerCount = (tag1 >>> 28 & 0x0F) || 16;
            const registers = data.getBigUint64(cursor + 8, true);
            cursor += 0x10;
            if (format !== 0)
                break;
            for (let loop = 0; loop < loops; loop++) {
                for (let register = 0; register < registerCount; register++) {
                    if (cursor + 0x10 > directEnd)
                        break;
                    const descriptor = Number(registers >> BigInt(register * 4) & 0x0Fn);
                    if (descriptor === 0x0E && (data.getUint8(cursor + 8) & 0x7F) === wantedAddress)
                        return data.getBigUint64(cursor, true);
                    cursor += 0x10;
                }
            }
        }
        cursor = directEnd;
    }
    return null;
}

// Decode the static renderable contents of a stage sheet bundle. XFF2 symbols
// identify the 0x4c StageLayout arrays; legacy xff modules own the actual NMO
// model resources. Packed-reference linking determines ownership in-game, but
// all models and all layout instances in one streamed bundle have the same
// lifetime, so retaining both lists is also a safe static-viewer fallback for
// bundles which import a prototype through an unsupported object class.
export interface StageBundleDiagnostics {
    models?: unknown[];
    layouts?: unknown[];
    unassociatedModels?: string[];
}

interface AnbFrameZeroTrack {
    type: number;
    name: string;
    descriptorOffset: number;
    trackOffset: number;
    positionPointer: number;
    rotationPointer: number;
    scalePointer: number;
    modes: { position: number; rotation: number; scale: number };
    position: vec3;
    rotation: quat;
    scale: vec3;
    matrix: mat4;
}

function readOffsetCString(bytes: Uint8Array, offset: number): string {
    if (offset < 0 || offset >= bytes.length)
        throw new Error('ANB string pointer exceeds relocated XFF image');
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end === bytes.length)
        throw new Error('ANB string is not terminated');
    return ascii(bytes, offset, end - offset);
}

function decodeAnbVector(view: DataView, pointer: number, mode: number, scale: boolean): vec3 {
    if (pointer === 0)
        return scale ? vec3.fromValues(1, 1, 1) : vec3.create();
    if (pointer < 0 || pointer + 12 > view.byteLength)
        throw new Error('ANB vector pointer exceeds relocated XFF image');
    if (mode === 0 || mode === 1 || mode > 3)
        return vec3.fromValues(
            view.getFloat32(pointer, true),
            view.getFloat32(pointer + 4, true),
            view.getFloat32(pointer + 8, true),
        );
    if (pointer + 0x1C > view.byteLength)
        throw new Error('ANB quantized vector header exceeds relocated XFF image');
    const samples = view.getUint32(pointer + 0x18, true);
    let x: number, y: number, z: number;
    if (mode === 2) {
        if (samples + (scale ? 4 : 6) > view.byteLength)
            throw new Error('ANB quantized vector sample exceeds relocated XFF image');
        if (scale) {
            const packed = view.getUint32(samples, true);
            x = packed >>> 21;
            y = packed >>> 10 & 0x7FF;
            z = packed & 0x3FF;
            return vec3.fromValues(
                view.getFloat32(pointer, true) + x * view.getFloat32(pointer + 4, true) / 2047,
                view.getFloat32(pointer + 8, true) + y * view.getFloat32(pointer + 0x0C, true) / 2047,
                view.getFloat32(pointer + 0x10, true) + z * view.getFloat32(pointer + 0x14, true) / 1023,
            );
        }
        x = view.getInt16(samples, true);
        y = view.getInt16(samples + 2, true);
        z = view.getInt16(samples + 4, true);
        return vec3.fromValues(
            view.getFloat32(pointer, true) + x * view.getFloat32(pointer + 4, true) / 32767,
            view.getFloat32(pointer + 8, true) + y * view.getFloat32(pointer + 0x0C, true) / 32767,
            view.getFloat32(pointer + 0x10, true) + z * view.getFloat32(pointer + 0x14, true) / 32767,
        );
    }
    if (!scale)
        return vec3.fromValues(
            view.getFloat32(pointer, true),
            view.getFloat32(pointer + 4, true),
            view.getFloat32(pointer + 8, true),
        );
    if (samples + 2 > view.byteLength)
        throw new Error('ANB quantized scale sample exceeds relocated XFF image');
    const packed = view.getUint16(samples, true);
    return vec3.fromValues(
        view.getFloat32(pointer, true) + (packed >>> 11) * view.getFloat32(pointer + 4, true) / 31,
        view.getFloat32(pointer + 8, true) + (packed >>> 5 & 0x3F) * view.getFloat32(pointer + 0x0C, true) / 31,
        view.getFloat32(pointer + 0x10, true) + (packed & 0x1F) * view.getFloat32(pointer + 0x14, true) / 31,
    );
}

function decodeAnbFrameZero(module: RelocatedXff): AnbFrameZeroTrack[] {
    const bytes = module.image.createTypedArray(Uint8Array);
    const view = module.image.createDataView();
    const root = module.entryOffset;
    if (root <= 0 || root + 0x18 > view.byteLength)
        throw new Error('Invalid relocated ANB root');
    const descriptors = view.getUint32(root + 0x10, true);
    const count = view.getUint32(root + 0x14, true);
    if (count > 0x10000 || descriptors + count * 0x0C > view.byteLength)
        throw new Error('Invalid relocated ANB track table');
    const tracks: AnbFrameZeroTrack[] = [];
    const reflectZ = mat4.fromScaling(mat4.create(), [1, 1, -1]);
    for (let i = 0; i < count; i++) {
        const descriptor = descriptors + i * 0x0C;
        const type = view.getUint32(descriptor, true);
        const name = readOffsetCString(bytes, view.getUint32(descriptor + 4, true));
        const track = view.getUint32(descriptor + 8, true);
        if (track + 0x10 > view.byteLength)
            throw new Error('ANB transform track exceeds relocated XFF image');
        const positionPointer = view.getUint32(track + 4, true);
        const rotationPointer = view.getUint32(track + 8, true);
        const scalePointer = view.getUint32(track + 0x0C, true);
        const modes = {
            position: view.getUint8(track + 2),
            rotation: view.getUint8(track + 1),
            scale: view.getUint8(track),
        };
        const position = decodeAnbVector(view, positionPointer, modes.position, false);
        const rotation = quat.create();
        if (rotationPointer !== 0) {
            if (modes.rotation !== 0 || rotationPointer + 0x10 > view.byteLength)
                throw new Error(`Unsupported frame-zero ANB quaternion mode ${modes.rotation}`);
            quat.set(rotation,
                view.getFloat32(rotationPointer, true), view.getFloat32(rotationPointer + 4, true),
                view.getFloat32(rotationPointer + 8, true), view.getFloat32(rotationPointer + 0x0C, true));
            quat.normalize(rotation, rotation);
        }
        const scale = decodeAnbVector(view, scalePointer, modes.scale, true);
        const gameMatrix = mat4.fromRotationTranslationScale(mat4.create(), rotation, position, scale);
        const viewerMatrix = mat4.multiply(mat4.create(), reflectZ, gameMatrix);
        mat4.multiply(viewerMatrix, viewerMatrix, reflectZ);
        tracks.push({
            type, name, descriptorOffset: descriptor, trackOffset: track,
            positionPointer, rotationPointer, scalePointer, modes,
            position, rotation, scale, matrix: viewerMatrix,
        });
    }
    return tracks;
}

export function parseStageBundle(
    buffer: ArrayBufferSlice,
    debugLabel = '',
    diagnostics?: StageBundleDiagnostics,
): TerrainMesh[] {
    const bytes = buffer.createTypedArray(Uint8Array);
    const data = buffer.createDataView();
    const entries = parseSheetSegmentEntries(bytes);
    interface XffSymbol {
        name: string;
        body: number;
        byteSize: number;
        moduleStart: number;
        modulePaths: string[];
    }
    const symbols: XffSymbol[] = [];
    const sheets = new Map<number, XffSymbol>();
    const stageLayouts: {
        matrix: mat4;
        targetHash: number;
        recordOffset: number;
        serializedTranslation: vec3;
        serializedRotationDegrees: vec3;
        serializedScale: vec3;
    }[] = [];
    const packedTarget = (field: number): { hash: number; type: number } | null => {
        if (field < 0 || field + 4 > data.byteLength) return null;
        const packed = data.getUint32(field, true);
        const distance = packed & 0x3FFFF;
        const anchor = field - distance;
        if (distance === 0 || anchor < 0 || anchor + 0x0C > data.byteLength)
            return null;
        return {
            hash: data.getUint32(anchor + 4, true),
            type: data.getUint32(anchor + 8, true),
        };
    };
    for (const entry of entries) {
        const moduleStart = entry.payloadStart;
        if (entry.payloadSize < 0x70 || ascii(bytes, moduleStart, 4) !== 'xff2')
            continue;
        const moduleSize = data.getUint32(moduleStart + 0x14, true);
        const symbolCount = data.getUint32(moduleStart + 0x24, true);
        const symbolTable = data.getUint32(moduleStart + 0x54, true);
        const strings = data.getUint32(moduleStart + 0x58, true);
        const sectionCount = data.getUint32(moduleStart + 0x40, true);
        const sectionTable = data.getUint32(moduleStart + 0x5C, true);
        if (moduleSize !== entry.payloadSize ||
            symbolCount > 0x10000 || symbolTable + symbolCount * 0x10 > moduleSize ||
            sectionCount > 0x1000 || sectionTable + sectionCount * 0x20 > moduleSize)
            continue;
        const moduleText = ascii(bytes, moduleStart, moduleSize);
        const modulePaths = [...moduleText.matchAll(/nmo\/[A-Za-z0-9_./-]+\.nmo\x00/g)]
            .map((match) => match[0].slice(0, -1));
        for (let i = 0; i < symbolCount; i++) {
            const symbol = moduleStart + symbolTable + i * 0x10;
            let nameAt = moduleStart + strings + data.getUint32(symbol, true);
            let nameEnd = nameAt;
            while (nameEnd < moduleStart + moduleSize && bytes[nameEnd] !== 0) nameEnd++;
            const name = ascii(bytes, nameAt, nameEnd - nameAt);
            const sectionIndex = data.getUint16(symbol + 0x0E, true);
            if (sectionIndex >= sectionCount) continue;
            const section = moduleStart + sectionTable + sectionIndex * 0x20;
            const body = moduleStart + data.getUint32(section + 0x1C, true) + data.getUint32(symbol + 4, true);
            const bodySize = data.getUint32(symbol + 8, true);
            if (body < moduleStart || body + bodySize > moduleStart + moduleSize)
                continue;
            const parsedSymbol = { name, body, byteSize: bodySize, moduleStart, modulePaths };
            symbols.push(parsedSymbol);
            if (name.startsWith('SH_') && bodySize >= 0x10)
                sheets.set(data.getUint32(body + 4, true), parsedSymbol);
            if (!name.startsWith('_StageLayout')) continue;
            for (let record = body; record + 0x4C <= body + bodySize; record += 0x4C) {
                if (data.getUint32(record, true) === 0)
                    continue;
                const tx = data.getFloat32(record + 0x18, true);
                const ty = data.getFloat32(record + 0x1C, true);
                const tz = data.getFloat32(record + 0x20, true);
                const rx = data.getFloat32(record + 0x24, true);
                const ry = data.getFloat32(record + 0x28, true);
                const rz = data.getFloat32(record + 0x2C, true);
                const scale = vec3.fromValues(
                    data.getFloat32(record + 0x30, true),
                    data.getFloat32(record + 0x34, true),
                    data.getFloat32(record + 0x38, true),
                );
                if (![tx, ty, tz, rx, ry, rz, ...scale].every(Number.isFinite))
                    continue;
                const rotation = quat.create();
                // gl-matrix composes its Euler quaternion in ZYX order. Build
                // the game's YXZ order explicitly.
                // StageLayoutInstanceCreate converts serialized layout space
                // to engine space as translation (-x,+y,-z) and Euler YXZ
                // (x,-y,z) before constructing the matrix.
                const qy = quat.setAxisAngle(quat.create(), [0, 1, 0], -ry * Math.PI / 180);
                const qx = quat.setAxisAngle(quat.create(), [1, 0, 0], rx * Math.PI / 180);
                const qz = quat.setAxisAngle(quat.create(), [0, 0, 1], rz * Math.PI / 180);
                quat.multiply(rotation, qy, qx);
                quat.multiply(rotation, rotation, qz);
                // StageLayoutInstanceCreate constructs this transform in the
                // game's coordinate system. Terrain vertices are decoded into
                // noclip space by reflecting Z, so convert the complete affine
                // transform with S * Mgame * S rather than adjusting Euler
                // components independently.
                const gameMatrix = mat4.fromRotationTranslationScale(
                    mat4.create(), rotation, [-tx, ty, -tz], scale,
                );
                const reflectZ = mat4.fromScaling(mat4.create(), [1, 1, -1]);
                const viewerMatrix = mat4.multiply(mat4.create(), reflectZ, gameMatrix);
                mat4.multiply(viewerMatrix, viewerMatrix, reflectZ);
                stageLayouts.push({
                    matrix: viewerMatrix,
                    targetHash: packedTarget(record + 4)?.hash ?? 0,
                    recordOffset: record,
                    serializedTranslation: vec3.fromValues(tx, ty, tz),
                    serializedRotationDegrees: vec3.fromValues(rx, ry, rz),
                    serializedScale: scale,
                });
            }
        }
    }

    const models = new Map<string, TerrainMesh[]>();
    const animations = new Map<string, AnbFrameZeroTrack[]>();
    const modelInventory: {
        source: string;
        moduleOffset: string;
        meshes: number;
        triangles: number;
        bounds: { min: number[]; max: number[] } | null;
    }[] = [];
    for (const entry of entries) {
        const start = entry.payloadStart;
        if (entry.payloadSize < 0x70 || ascii(bytes, start, 4) !== 'xff\0')
            continue;
        const size = data.getUint32(start + 0x14, true);
        if (size !== entry.payloadSize) continue;
        const sheet = buffer.slice(start, start + size);
        const sourceName = /(?:^|\/)nmo\/[A-Za-z0-9_./-]+\.nmo$/i.test(entry.path) ||
            /^[A-Za-z0-9_./-]+\.nmo$/i.test(entry.path) ? entry.path : '';
        const animationPath = /^anim\/[A-Za-z0-9_./-]+\.anb$/i.test(entry.path)
            ? entry.path.toLowerCase() : '';
        if (animationPath !== '') {
            try {
                const relocated = relocateLegacyXff(sheet);
                animations.set(animationPath, decodeAnbFrameZero(relocated));
            } catch (error) {
                // Not every .anb resource is an object-transform animation.
                // Only retain modules with the AnimationResource root shape.
                if (debugLabel !== '')
                    console.warn(`[SotC] skipped non-object ANB ${animationPath} at 0x${start.toString(16)}`, error);
            }
        }
        const meshes = parseNmoXff(sheet, sourceName);
        if (sourceName !== '' || meshes.some((mesh) => mesh.vertices.length !== 0)) {
            const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
            for (const mesh of meshes)
                for (let i = 0; i < mesh.vertices.length; i += 14) {
                    bounds[0] = Math.min(bounds[0], mesh.vertices[i]);
                    bounds[1] = Math.min(bounds[1], mesh.vertices[i + 1]);
                    bounds[2] = Math.min(bounds[2], mesh.vertices[i + 2]);
                    bounds[3] = Math.max(bounds[3], mesh.vertices[i]);
                    bounds[4] = Math.max(bounds[4], mesh.vertices[i + 1]);
                    bounds[5] = Math.max(bounds[5], mesh.vertices[i + 2]);
                }
            modelInventory.push({
                source: sourceName || '(unknown NMO)',
                moduleOffset: `0x${start.toString(16)}`,
                meshes: meshes.filter((mesh) => mesh.vertices.length !== 0).length,
                triangles: meshes.reduce((sum, mesh) => sum + mesh.vertices.length / 14 / 3, 0),
                bounds: Number.isFinite(bounds[0]) ? {
                    min: bounds.slice(0, 3),
                    max: bounds.slice(3, 6),
                } : null,
            });
        }
        if (meshes.some((mesh) => mesh.vertices.length !== 0))
            models.set(sourceName.replace(/^nmo\//, '').toLowerCase(), meshes);
    }
    if (debugLabel !== '')
        console.warn(`[SotC] ${debugLabel} stage bundle resources`, {
            layoutInstances: stageLayouts.length,
            renderableModels: models.size,
            animations: [...animations].map(([path, tracks]) => ({ path, tracks: tracks.length })),
            resources: modelInventory,
            rawBounds: modelInventory.map(({ source, bounds }) =>
                `${source}: ${bounds === null ? 'empty' : `${bounds.min.join(',')} .. ${bounds.max.join(',')}`}`),
        });
    if (diagnostics !== undefined)
        diagnostics.models = modelInventory;
    if (models.size === 0) {
        if (diagnostics !== undefined) {
            diagnostics.layouts = stageLayouts.map((layout) => ({
                targetHash: `0x${layout.targetHash.toString(16)}`,
                target: sheets.get(layout.targetHash)?.name ?? null,
                result: 'no decoded models in bundle',
            }));
            diagnostics.unassociatedModels = modelInventory.map((model) => model.source);
        }
        return [];
    }
    if (stageLayouts.length === 0) {
        if (diagnostics !== undefined) {
            diagnostics.layouts = [];
            diagnostics.unassociatedModels = [];
        }
        return [...models.values()].flat();
    }

    const symbolForSheet = (sheet: XffSymbol): XffSymbol | undefined => {
        const wanted = `_${sheet.name.slice(3)}`;
        return symbols.find((symbol) =>
            symbol.moduleStart === sheet.moduleStart && symbol.name === wanted);
    };
    const ownedModelPaths = (rootHash: number): {
        paths: Set<string>;
        animatedChildren: { path: string; animationPath: string; track: AnbFrameZeroTrack }[];
        baseLayoutDebug: unknown;
        trace: unknown[];
        directPlacement: boolean;
        suppressStaticBase: boolean;
    } => {
        const paths = new Set<string>();
        const animatedChildren: { path: string; animationPath: string; track: AnbFrameZeroTrack }[] = [];
        let baseLayoutDebug: unknown = null;
        const visited = new Set<number>();
        const trace: unknown[] = [];
        let directPlacement = false;
        let suppressStaticBase = false;
        const visit = (hash: number): void => {
            if (visited.has(hash)) {
                trace.push({ hash: `0x${hash.toString(16)}`, result: 'already visited' });
                return;
            }
            visited.add(hash);
            const sheet = sheets.get(hash);
            if (sheet === undefined) {
                trace.push({ hash: `0x${hash.toString(16)}`, result: 'sheet hash not found' });
                return;
            }
            const element = symbolForSheet(sheet);
            if (element === undefined) {
                trace.push({ hash: `0x${hash.toString(16)}`, sheet: sheet.name, result: 'element symbol not found' });
                return;
            }
            // GAMECORE's initSlowObject consumes definitions of this exported
            // type through its dedicated slow-object list. It resolves the
            // contained GameObject -> LayoutObjDef -> DispObjDef reference and
            // passes the model directly to CreateLayoutObjVU0Secure; no
            // StageLayout matrix is read. Preserve that distinct init path.
            if (element.name.startsWith('_LayoutObjDefSLOWOBJ_'))
                directPlacement = true;
            if (element.name.startsWith('_SlowGroupNameDef') ||
                element.name.startsWith('_SlowGroupDef') ||
                element.name.startsWith('_SlowObjDef'))
                directPlacement = true;
            if (element.name.includes('DispObjDef') ||
                element.name.startsWith('_ScriptCharObjDef') ||
                element.name.startsWith('_AnimObjDef'))
                for (const path of element.modulePaths)
                    paths.add(path.replace(/^nmo\//, '').toLowerCase());
            let fields: number[];
            if (element.name.startsWith('_GameObject')) {
                // StageLayoutInstanceCreate resolves GameObject +0x10. The
                // exported element symbol begins at that field.
                fields = [element.body];
            } else if (element.name.startsWith('_SlowGroupNameDef') ||
                       element.name.startsWith('_SlowGroupDef')) {
                // The +0x34 seamless-cell reference resolves to this group.
                // Its serialized body owns a count/list of SlowObjDef sheet
                // references; follow all valid packed references because the
                // exported symbol may cover more than one group variant.
                fields = Array.from(
                    { length: Math.floor(element.byteSize / 4) },
                    (_, index) => element.body + index * 4,
                ).filter((field) => packedTarget(field) !== null);
            } else if (element.name.startsWith('_SlowObjDef')) {
                // initSlowObject walks 0x0c-byte entries and resolves the
                // LayoutObjDef reference stored at entry +0x04.
                fields = [element.body + 4];
            } else if (element.name.startsWith('_LayoutObjDef')) {
                // Each 0x18-byte layout definition selects its display object
                // at +0x04. Multiple definitions share one typed sheet.
                fields = [];
                for (let record = element.body; record + 8 <= element.body + element.byteSize; record += 0x18)
                    fields.push(record + 4);
            } else if (element.name.startsWith('_ScriptLwsorientObjDef')) {
                fields = [element.body + 4, element.body + 0x10];
            } else if (element.name.startsWith('_ScriptCharObjDef')) {
                // The render and animation definitions are at +0x14/+0xE0.
                fields = [element.body + 0x14, element.body + 0xE0];
            } else if (element.name.startsWith('_ScriptLayoutObjDef')) {
                fields = [element.body, element.body + 8];
            } else if (element.name.startsWith('_LwsorientRes')) {
                fields = [element.body + 4];
            } else if (element.name.startsWith('_ScriptAnimationObjDef')) {
                // The referenced layout is the prototype used to instantiate
                // the ANB tracks. Rendering it once more as an ordinary static
                // leaf creates an extra segment at the controller origin.
                suppressStaticBase = true;
                // CreateScriptAnimationObj initializes the controller's base
                // layout from +0x28. The animation-definition references at
                // +0x04/+0x08 subsequently drive that layout's child state.
                fields = [element.body + 0x28];
                const baseTarget = packedTarget(element.body + 0x28);
                const baseSheet = baseTarget === null ? undefined : sheets.get(baseTarget.hash);
                const baseElement = baseSheet === undefined ? undefined : symbolForSheet(baseSheet);
                if (baseElement !== undefined) {
                    const dumpStart = Math.max(baseElement.moduleStart, baseElement.body - 0x20);
                    const dumpEnd = Math.min(bytes.length, baseElement.body + 0x60);
                    baseLayoutDebug = {
                        sheet: baseSheet!.name,
                        symbol: baseElement.name,
                        symbolBody: `0x${baseElement.body.toString(16)}`,
                        symbolByteSize: baseElement.byteSize,
                        dumpStart: `0x${dumpStart.toString(16)}`,
                        words: Array.from(
                            { length: Math.floor((dumpEnd - dumpStart) / 4) },
                            (_, i) => `0x${data.getUint32(dumpStart + i * 4, true).toString(16)}`,
                        ),
                    };
                }
                const seenAnimations = new Set<string>();
                for (const field of [element.body + 4, element.body + 8]) {
                    const target = packedTarget(field);
                    const animationSheet = target === null ? undefined : sheets.get(target.hash);
                    const animationElement = animationSheet === undefined ? undefined : symbolForSheet(animationSheet);
                    if (animationElement === undefined)
                        continue;
                    const searchEnd = Math.min(bytes.length,
                        animationElement.body + animationElement.byteSize + 0x100);
                    const text = ascii(bytes, animationElement.body, searchEnd - animationElement.body);
                    for (const match of text.matchAll(/anim\/[A-Za-z0-9_./-]+\.anb\x00/g)) {
                        const animationPath = match[0].slice(0, -1).toLowerCase();
                        if (seenAnimations.has(animationPath))
                            continue;
                        seenAnimations.add(animationPath);
                        for (const track of animations.get(animationPath) ?? []) {
                            if (track.type !== 1 && track.type !== 5)
                                continue;
                            const path = `${track.name.replace(/^nmo\//, '')}.nmo`.toLowerCase();
                            animatedChildren.push({ path, animationPath, track });
                        }
                    }
                }
            } else {
                fields = [];
            }
            const targets = fields.map((field) => {
                const target = packedTarget(field);
                return {
                    field: `0x${(field - element.body).toString(16)}`,
                    targetHash: target === null ? null : `0x${target.hash.toString(16)}`,
                    targetType: target === null ? null : `0x${target.type.toString(16)}`,
                    targetSheet: target === null ? null : sheets.get(target.hash)?.name ?? null,
                };
            });
            trace.push({
                hash: `0x${hash.toString(16)}`,
                sheet: sheet.name,
                element: element.name,
                elementBody: `0x${element.body.toString(16)}`,
                ...((element.name.includes('Slow') || element.name.includes('SLOW')) ? {
                    elementWords: Array.from(
                        { length: Math.min(0x20, Math.floor(element.byteSize / 4)) },
                        (_, i) => `0x${data.getUint32(element.body + i * 4, true).toString(16)}`,
                    ),
                } : {}),
                modulePaths: element.modulePaths,
                followedFields: targets,
                result: fields.length === 0 ? 'unsupported/static leaf' : 'traversed',
                ...(element.name.startsWith('_ScriptAnimationObjDef') ? {
                    // CreateScriptAnimationObj does not treat this as a plain
                    // display-object pointer. It initializes an AnimationDef
                    // and creates typed child layout objects from its tracks.
                    // Report every packed sheet reference in the serialized
                    // definition so we can identify that AnimationDef and
                    // decode its frame-zero child state without guessing.
                    packedReferences: Array.from(
                        { length: Math.floor(element.byteSize / 4) },
                        (_, i) => element.body + i * 4,
                    ).map((field) => ({ field, target: packedTarget(field) }))
                        .filter(({ target }) => target !== null)
                        .map(({ field, target }) => ({
                            field: `0x${(field - element.body).toString(16)}`,
                            raw: `0x${data.getUint32(field, true).toString(16)}`,
                            targetHash: `0x${target!.hash.toString(16)}`,
                            targetType: `0x${target!.type.toString(16)}`,
                            targetSheet: sheets.get(target!.hash)?.name ?? null,
                        })),
                } : {}),
            });
            for (const field of fields) {
                const target = packedTarget(field);
                if (target !== null && sheets.has(target.hash)) {
                    visit(target.hash);
                }
            }
        };
        visit(rootHash);
        return { paths, animatedChildren, baseLayoutDebug, trace, directPlacement, suppressStaticBase };
    };
    const output: TerrainMesh[] = [];
    const associations = [];
    const associatedModels = new Set<string>();
    for (const layout of stageLayouts) {
        const {
            paths, animatedChildren, baseLayoutDebug, trace, directPlacement, suppressStaticBase,
        } = ownedModelPaths(layout.targetHash);
        const parentOrigin = [layout.matrix[12], layout.matrix[13], layout.matrix[14]];
        associations.push({
            targetHash: `0x${layout.targetHash.toString(16)}`,
            target: sheets.get(layout.targetHash)?.name ?? `0x${layout.targetHash.toString(16)}`,
            models: [...paths],
            stageLayout: {
                recordOffset: `0x${layout.recordOffset.toString(16)}`,
                serializedTranslation: [...layout.serializedTranslation],
                serializedRotationDegrees: [...layout.serializedRotationDegrees],
                serializedScale: [...layout.serializedScale],
                viewerOrigin: parentOrigin,
            },
            baseLayoutDebug,
            animatedChildren: animatedChildren.map((child, index) => {
                const composed = mat4.multiply(mat4.create(), layout.matrix, child.track.matrix);
                return {
                    index,
                    path: child.path,
                    animationPath: child.animationPath,
                    type: child.track.type,
                    descriptorOffset: `0x${child.track.descriptorOffset.toString(16)}`,
                    trackOffset: `0x${child.track.trackOffset.toString(16)}`,
                    pointers: {
                        position: `0x${child.track.positionPointer.toString(16)}`,
                        rotation: `0x${child.track.rotationPointer.toString(16)}`,
                        scale: `0x${child.track.scalePointer.toString(16)}`,
                    },
                    modes: child.track.modes,
                    position: [...child.track.position],
                    rotation: [...child.track.rotation],
                    scale: [...child.track.scale],
                    localViewerOrigin: [child.track.matrix[12], child.track.matrix[13], child.track.matrix[14]],
                    composedViewerOrigin: [composed[12], composed[13], composed[14]],
                };
            }),
            placement: directPlacement ? 'direct' : 'stage-layout',
            suppressStaticBase,
            trace,
        });
        for (const path of suppressStaticBase ? [] : paths) {
            const model = models.get(path);
            if (model === undefined) continue;
            associatedModels.add(path);
            for (const mesh of model) {
                if (directPlacement)
                    output.push({ ...mesh, isProp: true, stagePlacement: 'direct' });
                else
                    output.push(transformMesh(mesh, layout.matrix));
            }
        }
        for (const child of animatedChildren) {
            const model = models.get(child.path);
            if (model === undefined) continue;
            associatedModels.add(child.path);
            const childMatrix = mat4.multiply(mat4.create(), layout.matrix, child.track.matrix);
            for (const mesh of model)
                output.push(transformMesh(mesh, childMatrix));
        }
    }
    if (diagnostics !== undefined) {
        diagnostics.layouts = associations;
        diagnostics.unassociatedModels = [...models.keys()]
            .filter((path) => !associatedModels.has(path)).sort();
    }
    if (debugLabel !== '')
        console.warn(`[SotC] ${debugLabel} resolved stage associations`, associations);
    return output;
}

export function placeStageBundle(meshes: TerrainMesh[], cellOriginX: number, cellOriginZ: number): TerrainMesh[] {
    // initlayout's game-space coarse origin has already been converted to the
    // viewer's reflected-Z grid by the caller.
    const translation = mat4.fromTranslation(mat4.create(), [cellOriginX, 0, cellOriginZ]);
    return meshes.map((mesh) => mesh.stagePlacement === 'direct' ? mesh : transformMesh(mesh, translation));
}

function parseNmoXff(serialized: ArrayBufferSlice, sourceNameHint = ''): TerrainMesh[] {
    const relocated = relocateLegacyXff(serialized);
    // NMO draw chains contain loader-time packet fields among their relocation
    // targets. Decode geometry from the serialized image; use the common XFF
    // parser for section and entry metadata, and convert the NMO's serialized
    // section-relative fields explicitly below.
    const buffer = serialized;
    const bytes = buffer.createTypedArray(Uint8Array);
    const data = buffer.createDataView();
    const nmo = relocated.entryOffset;
    if (nmo + 0x80 > data.byteLength || ascii(bytes, nmo, 4) !== 'NMO\0')
        return [];
    const modelStart = Math.min(...relocated.sections
        .filter((section) => section.type === 1 && section.size !== 0)
        .map((section) => section.fileOffset));
    if (!Number.isFinite(modelStart))
        return [];
    // These are the same relocated NMO root fields consumed by the game.
    // Do not search for tag text: XFF metadata can itself contain strings such
    // as "TEX\0", which is not a serialized TEX record.
    // TEX/SRF serialized records carry a three-byte prefix before the runtime
    // object address (the tag itself). Convert the relocated runtime pointer
    // back to the start of the on-disc record.
    const textureTable = modelStart + data.getUint32(nmo + 0x40, true) - 3;
    const textureCount = data.getUint32(nmo + 0x44, true);
    const surfaceTable = modelStart + data.getUint32(nmo + 0x50, true) - 3;
    const surfaceCount = data.getUint32(nmo + 0x54, true);
    const drawTable = modelStart + data.getUint32(nmo + 0x60, true);
    const drawCount = data.getUint32(nmo + 0x64, true);
    if (textureCount > 100000 || surfaceCount > 100000 || drawCount > 100000 ||
        textureTable + textureCount * 0x20 > data.byteLength ||
        surfaceTable + surfaceCount * 0x120 > data.byteLength ||
        drawTable + drawCount * 0x20 > data.byteLength)
        return [];

    const texRecords = Array.from({ length: textureCount }, (_, i) => textureTable + i * 0x20);
    const srfRecords = Array.from({ length: surfaceCount }, (_, i) => surfaceTable + i * 0x120);
    if (texRecords.some((record) => ascii(bytes, record + 3, 4) !== 'TEX\0') ||
        srfRecords.some((record) => ascii(bytes, record + 3, 4) !== 'SRF\0'))
        return [];
    // The NMO root is followed by count-directed texture and surface names,
    // then the model filename. These are model metadata, not XFF fingerprints.
    let nameCursor = nmo + 0x80;
    const readName = (): string => {
        const start = nameCursor;
        while (nameCursor < bytes.length && bytes[nameCursor] !== 0) nameCursor++;
        if (nameCursor === bytes.length)
            throw new Error('Unterminated NMO resource name');
        const name = ascii(bytes, start, nameCursor - start);
        nameCursor++;
        return name;
    };
    const textureNames = Array.from({ length: textureCount }, readName);
    const surfaceNames = Array.from({ length: surfaceCount }, readName);
    const serializedName = readName();
    const nmoPath = sourceNameHint || serializedName || '(NMO)';
    const unsupportedDraws: {
        draw: number;
        surface: string;
        chainSize: number;
        chainOffset: string;
        texture: string | null;
        gsAlpha: string;
        candidates: {
            headerBatch: number;
            headerCount: number;
            positionBatch: number | null;
            positionCount: number | null;
            positionBounds: string | null;
            streamDetails: string;
            rejection: string[];
        }[];
        unpackSequence: string;
    }[] = [];
    const isInputStream = (batch: UnpackBatch, header: UnpackBatch, slot: number, format?: string): boolean =>
        batch.address === ((header.address + slot) & 0x03FF) &&
        !batch.masked && (format === undefined || batch.format === format);
    const outputs = new Map<string, {
        textureName: string | null;
        secondaryTextureName: string | null;
        isProp: boolean;
        isLayer1: boolean;
        isSpecialLayer: boolean;
        isTranslucent: boolean;
        isWater: boolean;
        hasWaterEffect: boolean;
        gsAlpha: number;
        gsAlphaFix: number;
        disableCull: boolean;
        clampS: boolean;
        clampT: boolean;
        secondaryClampS: boolean;
        secondaryClampT: boolean;
        vertices: number[];
        skinningControl: number[];
        deformationData: number[];
    }>();
    for (let draw = 0; draw < drawCount; draw++) {
        const desc = drawTable + draw * 0x20;
        const surfaceIndex = data.getUint32(desc + 8, true);
        const surface = srfRecords[surfaceIndex];
        const textureIndex = surface === undefined ? -1 : data.getUint32(surface + 0x2F, true);
        const textureName = textureNames[textureIndex] ?? null;
        const textureMode = surface === undefined ? 0 : data.getUint32(surface + 0x1F, true);
        const secondaryTextureIndex = surface === undefined ? -1 : data.getUint32(surface + 0x3F, true);
        const secondaryTextureName = textureMode === 2 ? textureNames[secondaryTextureIndex] ?? null : null;
        const surfaceFlags = surface === undefined ? 0 : data.getUint32(surface + 0x1B, true);
        const surfaceName = surfaceNames[surfaceIndex] ?? `surface_${surfaceIndex}`;
        const hasWaterEffect = (surfaceFlags & 0x2200) === 0x2200;
        const isWater = hasWaterEffect;
        const alphaRegister = surface === undefined ? null : readSrfGsRegister(data, surface, 0x42);
        const gsAlpha = alphaRegister === null ? 0x44 : Number(alphaRegister & 0xFFFFFFFFn);
        const gsAlphaFix = alphaRegister === null ? 0x80 : Number(alphaRegister >> 32n & 0xFFn);
        // Ordered exactly as modelGetDlLayer. The final ordinary-material
        // branches depend on runtime model/fade state, but every nonordinary
        // branch below is determined before those fields are consulted.
        let fixedDisplayLayer: number | null = null;
        if ((surfaceFlags & 0x01020000) !== 0) fixedDisplayLayer = 8;
        else if ((surfaceFlags & 0x00800000) !== 0) fixedDisplayLayer = 10;
        else if ((surfaceFlags & 0x02000000) !== 0) fixedDisplayLayer = 16;
        else if ((surfaceFlags & 0x00000200) !== 0) fixedDisplayLayer = 17;
        else if ((surfaceFlags & 0x00000400) !== 0)
            fixedDisplayLayer = (surfaceFlags & 0x00000100) !== 0 ? 13 : 12;
        else if ((surfaceFlags & 0x00004000) !== 0) fixedDisplayLayer = 1;
        else if ((surfaceFlags & 0x00008000) !== 0) fixedDisplayLayer = 18;
        const isLayer1 = fixedDisplayLayer === 1;
        const isSpecialLayer = fixedDisplayLayer !== null && fixedDisplayLayer !== 1;
        // modelGetDlLayer tests this bit in the final ordinary-material
        // branch, selecting blended layer 3/6 instead of opaque layer 2/5.
        const isTranslucent = fixedDisplayLayer === null && (surfaceFlags & 0x00000100) !== 0;
        const clampRegister = surface === undefined ? null : readSrfGsRegister(data, surface, 0x08);
        const clamp = clampRegister === null ? 0 : Number(clampRegister & 0xFFFFFFFFn);
        const wms = clamp & 0x03, wmt = (clamp >>> 2) & 0x03;
        const secondaryClampRegister = surface === undefined ? null : readSrfGsRegister(data, surface, 0x09);
        const secondaryClamp = secondaryClampRegister === null ? 0 : Number(secondaryClampRegister & 0xFFFFFFFFn);
        const secondaryWms = secondaryClamp & 0x03, secondaryWmt = (secondaryClamp >>> 2) & 0x03;
        // A translucent draw needs its own spatial bounds and sort key.
        // Coalescing all uses of a material across an NMO made unrelated
        // foliage, decals, and prop instances sort as one cell-sized object.
        const sortGroup = isTranslucent ? `draw${draw}` : '';
        const key = `${textureName ?? `__untextured_${surfaceName}`}|${secondaryTextureName ?? ''}|${wms}|${wmt}|${secondaryWms}|${secondaryWmt}|${surfaceFlags}|${gsAlpha}|${gsAlphaFix}|${isWater}|${sortGroup}`;
        const output = outputs.get(key) ?? {
            textureName,
            secondaryTextureName,
            // Terrain-cell NMO geometry is never controlled by Enable Stages.
            // Stage-layout ownership is assigned by parseStageBundle.
            isProp: false,
            isLayer1,
            isSpecialLayer,
            isTranslucent,
            isWater,
            hasWaterEffect,
            gsAlpha,
            gsAlphaFix,
            disableCull: (surfaceFlags & 0x00010000) !== 0,
            clampS: wms !== 0,
            clampT: wmt !== 0,
            secondaryClampS: secondaryWms !== 0,
            secondaryClampT: secondaryWmt !== 0,
            vertices: [],
            skinningControl: [],
            deformationData: [],
        };
        const out = output.vertices;
        outputs.set(key, output);
        const chainSize = data.getUint32(desc, true);
        const chainStart = modelStart + data.getUint32(desc + 0x10, true);
        if (chainStart + chainSize > textureTable) continue;
        const batches = collectVifBatches(data, chainStart, chainSize);
        let decodedThisDraw = false;
        let decodedTriangleCount = 0;
        for (let i = 0; i + 2 < batches.length; i++) {
            const h = batches[i], p = batches[i + 1];
            let nrm: UnpackBatch | null = null;
            let packedNrm: UnpackBatch | null = null;
            let deformation: UnpackBatch | null = null;
            let skinning = false;
            let uv: UnpackBatch | null;
            let c: UnpackBatch;
            let batchCount: number;
            if (i + 3 < batches.length &&
                isInputStream(batches[i + 2], h, 2, 'V3-32') &&
                isInputStream(batches[i + 3], h, 3, 'V4-8')) {
                // VU 0x10a58 loads position, normal, and integer color from
                // offsets 0, 1, and 2, then advances by three qwords at
                // 0x10b78. The normal is transformed through vf13..vf16 and
                // modulates the converted color at 0x10b48.
                nrm = batches[i + 2];
                uv = null;
                c = batches[i + 3];
                batchCount = 4;
            } else if (isInputStream(batches[i + 2], h, 2, 'V4-8')) {
                // Untextured/helper geometry omits the UV stream.
                uv = null;
                c = batches[i + 2];
                batchCount = 3;
            } else if (i + 5 < batches.length &&
                isInputStream(batches[i + 2], h, 2, 'V4-16') &&
                isInputStream(batches[i + 3], h, 3) &&
                (batches[i + 3].format === 'V2-16' || batches[i + 3].format === 'V4-16') &&
                isInputStream(batches[i + 4], h, 4, 'V4-8') &&
                isInputStream(batches[i + 5], h, 5, 'V4-32') &&
                p.count === batches[i + 2].count &&
                p.count === batches[i + 3].count &&
                p.count === batches[i + 4].count &&
                p.count === batches[i + 5].count) {
                // Deformable six-stream prop input. V4-16 is a signed
                // fixed-point normal; V4-8 and the trailing V4-32 are skinning
                // control/data, not vertex color or another strip header.
                packedNrm = batches[i + 2];
                uv = batches[i + 3];
                c = batches[i + 4];
                deformation = batches[i + 5];
                skinning = true;
                batchCount = 6;
            } else if (i + 4 < batches.length &&
                isInputStream(batches[i + 2], h, 2, 'V3-32') &&
                isInputStream(batches[i + 3], h, 3) &&
                (batches[i + 3].format === 'V2-16' || batches[i + 3].format === 'V4-16') &&
                isInputStream(batches[i + 4], h, 4, 'V4-8')) {
                // Lit geometry can provide a serialized normal for each
                // position before its UV and color streams.
                nrm = batches[i + 2];
                uv = batches[i + 3];
                c = batches[i + 4];
                batchCount = 5;
            } else if (i + 3 < batches.length &&
                isInputStream(batches[i + 2], h, 2) &&
                isInputStream(batches[i + 3], h, 3, 'V4-8')) {
                uv = batches[i + 2];
                c = batches[i + 3];
                batchCount = 4;
            } else {
                continue;
            }
            if (h.format !== 'V4-32' || p.format !== 'V3-32' ||
                h.count !== 1 || h.masked || h.unsigned || p.unsigned ||
                !isInputStream(p, h, 1, 'V3-32') ||
                (uv !== null && uv.format !== 'V2-16' && uv.format !== 'V4-16') ||
                (uv !== null && uv.unsigned) || !c.unsigned ||
                c.format !== 'V4-8' || (nrm !== null && p.count !== nrm.count) ||
                (uv !== null && p.count !== uv.count) || p.count !== c.count)
                continue;
            // The game uploads a structure-of-arrays packet into an
            // array-of-structures VU block with STCYCL(WL=1, CL=stride).
            // Destination offsets 1..stride select each vertex member.
            const vertexStreams = [p, nrm, packedNrm, uv, c, deformation]
                .filter((batch): batch is UnpackBatch => batch !== null);
            const inputStride = batchCount - 1;
            if (!vertexStreams.every((batch) => batch.cycleWL === 1 && batch.cycleCL === inputStride))
                continue;
            // At 0x109f0 the VU reads header.x with ILWR and masks it with
            // 0x7ff. This is the authoritative strip vertex count; do not
            // infer topology solely from the adjacent UNPACK command.
            const headerVertexCount = data.getUint32(h.payloadOffset, true) & 0x07FF;
            if (headerVertexCount !== p.count)
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
                } else if (packedNrm !== null) {
                    const no = packedNrm.payloadOffset + vertex * 8;
                    nx = data.getInt16(no, true) / 4096;
                    ny = data.getInt16(no + 2, true) / 4096;
                    nz = -data.getInt16(no + 4, true) / 4096;
                    const length = Math.hypot(nx, ny, nz);
                    if (length > 1e-6) {
                        nx /= length; ny /= length; nz /= length;
                    }
                }
                // Flip Z to move the PS2 coordinate system into noclip space.
                out.push(data.getFloat32(po, true), data.getFloat32(po + 4, true), -data.getFloat32(po + 8, true),
                    nx, ny, nz,
                    skinning ? 1 : Math.min(1, data.getUint8(co) / 128),
                    skinning ? 1 : Math.min(1, data.getUint8(co + 1) / 128),
                    skinning ? 1 : Math.min(1, data.getUint8(co + 2) / 128),
                    skinning ? 1 : Math.min(1, data.getUint8(co + 3) / 128),
                    uv === null ? 0 : data.getInt16(uvo, true) / 4096,
                    uv === null ? 0 : data.getInt16(uvo + 2, true) / 4096,
                    uv === null || uv.format !== 'V4-16' ? (uv === null ? 0 : data.getInt16(uvo, true) / 4096) : data.getInt16(uvo + 4, true) / 4096,
                    uv === null || uv.format !== 'V4-16' ? (uv === null ? 0 : data.getInt16(uvo + 2, true) / 4096) : data.getInt16(uvo + 6, true) / 4096);
                if (skinning && deformation !== null) {
                    output.skinningControl.push(
                        data.getUint8(co), data.getUint8(co + 1),
                        data.getUint8(co + 2), data.getUint8(co + 3),
                    );
                    const deform = deformation.payloadOffset + vertex * 16;
                    output.deformationData.push(
                        data.getUint32(deform, true), data.getUint32(deform + 4, true),
                        data.getUint32(deform + 8, true), data.getUint32(deform + 12, true),
                    );
                }
            };
            for (let v = 2; v < headerVertexCount; v++) {
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
                decodedTriangleCount++;
                emit(a, nx, ny, nz); emit(b, nx, ny, nz); emit(v, nx, ny, nz);
            }
            i += batchCount - 1;
        }
        if (!decodedThisDraw || decodedTriangleCount === 0) {
            const candidates = batches.flatMap((header, headerBatch) => {
                if (header.format !== 'V4-32' || header.count !== 1) return [];
                const positionBatch = headerBatch + 1 < batches.length ? headerBatch + 1 : null;
                const position = positionBatch === null ? null : batches[positionBatch];
                const headerCount = data.getUint32(header.payloadOffset, true) & 0x07FF;
                const rejection: string[] = [];
                if (header.masked) rejection.push('header is masked');
                if (header.unsigned) rejection.push('header is unsigned');
                if (position === null) rejection.push('missing position stream');
                else {
                    if (position.format !== 'V3-32') rejection.push(`position format is ${position.format}`);
                    if (position.address !== ((header.address + 1) & 0x03FF))
                        rejection.push(`position destination is 0x${position.address.toString(16)}, expected 0x${((header.address + 1) & 0x03FF).toString(16)}`);
                    if (position.unsigned) rejection.push('position is unsigned');
                    if (position.count !== headerCount)
                        rejection.push(`header count ${headerCount} != position count ${position.count}`);
                }
                let positionBounds: string | null = null;
                if (position !== null && position.format === 'V3-32') {
                    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
                    for (let v = 0; v < position.count; v++) {
                        const o = position.payloadOffset + v * 12;
                        const x = data.getFloat32(o, true), y = data.getFloat32(o + 4, true), z = -data.getFloat32(o + 8, true);
                        bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.min(bounds[2], z);
                        bounds[3] = Math.max(bounds[3], x); bounds[4] = Math.max(bounds[4], y); bounds[5] = Math.max(bounds[5], z);
                    }
                    positionBounds = `[${bounds.slice(0, 3).join(', ')}]..[${bounds.slice(3, 6).join(', ')}]`;
                }
                const streams = batches.slice(headerBatch, Math.min(batches.length, headerBatch + 7));
                return [{
                    headerBatch,
                    headerCount,
                    positionBatch,
                    positionCount: position?.count ?? null,
                    positionBounds,
                    streamDetails: streams.map((b) =>
                        `${b.format}@0x${b.address.toString(16)} x${b.count} ` +
                        `cycle=${b.cycleCL}/${b.cycleWL} ${b.unsigned ? 'unsigned' : 'signed'}${b.masked ? ' masked' : ''}`,
                    ).join(' | '),
                    rejection: rejection.length === 0
                        ? [decodedThisDraw ? 'layout decoded but emitted zero nondegenerate triangles' : 'stream layout did not match a supported VU path']
                        : rejection,
                }];
            });
            unsupportedDraws.push({
                draw,
                surface: surfaceNames[surfaceIndex] ?? `surface_${surfaceIndex}`,
                chainSize,
                chainOffset: `0x${chainStart.toString(16)}`,
                texture: textureName,
                gsAlpha: `0x${gsAlpha.toString(16).padStart(8, '0')}`,
                candidates,
                unpackSequence: batches.length === 0
                    ? '(no recognized UNPACK commands)'
                    : batches.slice(0, 24).map((batch) =>
                        `${batch.format}@${batch.address.toString(16)}x${batch.count}`,
                    ).join(' → ') +
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
        sourceName: nmoPath,
        textureName: output.textureName,
        secondaryTextureName: output.secondaryTextureName,
        isProp: output.isProp,
        isLayer1: output.isLayer1,
        isSpecialLayer: output.isSpecialLayer,
        isTranslucent: output.isTranslucent,
        isWater: output.isWater,
        hasWaterEffect: output.hasWaterEffect,
        gsAlpha: output.gsAlpha,
        gsAlphaFix: output.gsAlphaFix,
        disableCull: output.disableCull,
        clampS: output.clampS,
        clampT: output.clampT,
        secondaryClampS: output.secondaryClampS,
        secondaryClampT: output.secondaryClampT,
        vertices: new Float32Array(output.vertices),
        skinningControl: output.skinningControl.length === 0 ? undefined : new Uint8Array(output.skinningControl),
        deformationData: output.deformationData.length === 0 ? undefined : new Uint32Array(output.deformationData),
    }));
}

// A seamless-map cell uses the older compact resource list, not the XFF2
// SheetSegmentLoad container used by stages and texture sheets. Each record is
// x/y/hash/pathSize/path/payloadSize/payload. Both formats converge at the
// exact legacy-XFF payload and therefore share parseNmoXff below that layer.
export function parseTerrainCell(buffer: ArrayBufferSlice): TerrainMesh[] {
    const bytes = buffer.createTypedArray(Uint8Array);
    const data = buffer.createDataView();
    if (ascii(bytes, 0, 4) === 'xff\0')
        return parseNmoXff(buffer);
    if (data.byteLength < 4)
        throw new Error('Truncated terrain-cell resource list');
    const count = data.getUint32(0, true);
    if (count > 0x10000)
        throw new Error('Invalid terrain-cell resource count');
    const output: TerrainMesh[] = [];
    let cursor = 4;
    for (let index = 0; index < count; index++) {
        if (cursor + 0x10 > data.byteLength)
            throw new Error(`Truncated terrain-cell resource ${index}`);
        const pathSize = data.getUint32(cursor + 0x0C, true);
        cursor += 0x10;
        if (pathSize === 0 || cursor + pathSize + 4 > data.byteLength || bytes[cursor + pathSize - 1] !== 0)
            throw new Error(`Invalid terrain-cell resource ${index} path`);
        const path = ascii(bytes, cursor, pathSize - 1);
        cursor += pathSize;
        const payloadSize = data.getUint32(cursor, true);
        cursor += 4;
        if (cursor + payloadSize > data.byteLength)
            throw new Error(`Invalid terrain-cell resource ${index} payload`);
        if (/(?:^|\/)nmo\/.*\.nmo$/i.test(path) || /^[^/]+\.nmo$/i.test(path))
            output.push(...parseNmoXff(buffer.slice(cursor, cursor + payloadSize), path));
        cursor += payloadSize;
    }
    if (cursor !== data.byteLength)
        throw new Error('Terrain-cell resource-list size mismatch');
    return output;
}

export interface DecodedTexture {
    name: string;
    width: number;
    height: number;
    pixels: Uint8Array;
    levels: Uint8Array[];
    alphaTest: number;
    alphaReference: number;
    alphaFail: number;
}

export function parseTexturePack(file: ArrayBufferSlice, physicalSheetCount: number, decompress: (src: Uint8Array) => Uint8Array): DecodedTexture[] {
    const bytes = file.createTypedArray(Uint8Array);
    const view = file.createDataView();
    if (ascii(bytes, 0, 8) === 'SOTCTX1\0')
        throw new Error('Unsupported SOTCTX1 texture-pack directory');
    const tableSize = physicalSheetCount * 4;
    if (tableSize > bytes.length)
        throw new Error('Truncated stage-texture size table');
    const payload = decompress(bytes.subarray(tableSize));
    const textures = new Map<string, DecodedTexture>();
    let offset = 0;
    for (let index = 0; index < physicalSheetCount; index++) {
        const byteSize = view.getUint32(index * 4, true);
        if (offset + byteSize > payload.length)
            throw new Error(`Truncated stage-texture sheet ${index}`);
        for (const texture of parseNto2Textures(payload.subarray(offset, offset + byteSize)))
            if (!textures.has(texture.name))
                textures.set(texture.name, texture);
        offset += byteSize;
    }
    if (offset !== payload.length)
        throw new Error('Stage-texture payload size mismatch');
    return [...textures.values()];
}

export function parseNto2Textures(payload: Uint8Array): DecodedTexture[] {
    const textures = new Map<string, DecodedTexture>();
    const gsMap = gsMemoryMapNew();
    const textureBasePointer = 0;
    const paletteBasePointer = 0x2000;
    const data = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    for (const entry of parseSheetSegmentEntries(payload)) {
        const moduleStart = entry.payloadStart;
        const moduleEnd = moduleStart + entry.payloadSize;
        if (entry.payloadSize < 0x70 || ascii(payload, moduleStart, 4) !== 'xff\0')
            continue;
        const symbolCount = data.getUint32(moduleStart + 0x24, true);
        const sectionCount = data.getUint32(moduleStart + 0x40, true);
        const symbolTable = data.getUint32(moduleStart + 0x54, true);
        const symbolStrings = data.getUint32(moduleStart + 0x58, true);
        const sectionTable = data.getUint32(moduleStart + 0x5C, true);
        if (symbolCount > 0x10000 || sectionCount > 0x1000 ||
            symbolTable + symbolCount * 0x10 > entry.payloadSize ||
            sectionTable + sectionCount * 0x20 > entry.payloadSize)
            continue;
        const wantedName = entry.path.replace(/^nto\//i, '').replace(/\.nto$/i, '');
        let offset = -1;
        for (let index = 0; index < symbolCount; index++) {
            const symbol = moduleStart + symbolTable + index * 0x10;
            const nameStart = moduleStart + symbolStrings + data.getUint32(symbol, true);
            let nameEnd = nameStart;
            while (nameEnd < moduleEnd && payload[nameEnd] !== 0) nameEnd++;
            if (nameEnd >= moduleEnd || ascii(payload, nameStart, nameEnd - nameStart) !== wantedName)
                continue;
            const sectionIndex = data.getUint16(symbol + 0x0E, true);
            if (sectionIndex >= sectionCount)
                continue;
            const section = moduleStart + sectionTable + sectionIndex * 0x20;
            const candidate = moduleStart + data.getUint32(section + 0x1C, true) +
                data.getUint32(symbol + 4, true);
            if (candidate + 0x98 <= moduleEnd && ascii(payload, candidate, 4) === 'NTO2')
                offset = candidate;
        }
        if (offset < 0)
            continue;
        const payloadEnd = moduleEnd;
        const pixelOffset = data.getUint32(offset + 0x14, true);
        const paletteOffset = data.getUint32(offset + 0x18, true);
        const packed = data.getUint32(offset + 0x1C, true);
        const psm = packed & 0x3F;
        // texTransResolve copies these NTO2 fields directly into GS TEST:
        // ATST[3:1], AREF[11:4], and AFAIL[13:12]. ATE is always enabled.
        const alphaTest = data.getUint32(offset + 0x80, true);
        const alphaReference = data.getUint32(offset + 0x84, true);
        const alphaFail = data.getUint32(offset + 0x88, true);
        const mipTransferModes = payload[offset + 0x1F];
        const mipCount = Math.max(1, (packed >>> 12) & 0x07);
        const width = 1 << (data.getUint16(offset + 0x1E, true) & 0x0F);
        const height = 1 << ((packed >>> 20) & 0x0F);
        const paletteBytes = psm === 0x14 ? 0x40 : psm === 0x13 ? 0x400 : 0;
        if (pixelOffset < 0x20 || paletteOffset < pixelOffset ||
            offset + paletteOffset + paletteBytes > payloadEnd)
            continue;
        const name = wantedName;
        const levels: Uint8Array[] = [];
        const palette = offset + paletteOffset;
        let mipPixelOffset = offset + pixelOffset;
        if (psm === GSPixelStorageFormat.PSMT4 || psm === GSPixelStorageFormat.PSMT8) {
            const paletteWidth = psm === GSPixelStorageFormat.PSMT4 ? 8 : 16;
            const paletteHeight = psm === GSPixelStorageFormat.PSMT4 ? 2 : 16;
            gsMemoryMapUploadImage(
                gsMap, GSPixelStorageFormat.PSMCT32, paletteBasePointer, 1,
                0, 0, paletteWidth, paletteHeight,
                ArrayBufferSlice.fromView(payload.subarray(palette, palette + paletteBytes)),
            );
            for (let level = 0; level < mipCount; level++) {
                const mipWidth = Math.max(1, width >>> level);
                const mipHeight = Math.max(1, height >>> level);
                const mipBytes = psm === GSPixelStorageFormat.PSMT4 ? Math.ceil(mipWidth * mipHeight / 2) : mipWidth * mipHeight;
                if (mipPixelOffset + mipBytes > offset + paletteOffset) break;
                const pixels = new Uint8Array(mipWidth * mipHeight * 4);
                const tbw = Math.max(1, Math.ceil(mipWidth / 64));
                const texels = ArrayBufferSlice.fromView(payload.subarray(mipPixelOffset, mipPixelOffset + mipBytes));
                // texTransResolve tests one bit per mip at NTO2 +0x1f. A set
                // bit uploads indexed bytes as PSMCT32 at reduced dimensions,
                // then samples the same GS memory using the declared PSM.
                if ((mipTransferModes & (1 << level)) !== 0)
                    gsMemoryMapUploadImage(
                        gsMap, GSPixelStorageFormat.PSMCT32, textureBasePointer, Math.max(1, tbw >>> 1),
                        0, 0, Math.max(1, mipWidth >>> 1),
                        Math.max(1, mipHeight >>> (psm === GSPixelStorageFormat.PSMT4 ? 2 : 1)), texels,
                    );
                else
                    gsMemoryMapUploadImage(gsMap, psm, textureBasePointer, tbw, 0, 0, mipWidth, mipHeight, texels);
                if (psm === GSPixelStorageFormat.PSMT4)
                    gsMemoryMapReadImagePSMT4_PSMCT32(
                        pixels, gsMap, textureBasePointer, tbw, mipWidth, mipHeight,
                        paletteBasePointer, 0, -1,
                    );
                else
                    gsMemoryMapReadImagePSMT8_PSMCT32(
                        pixels, gsMap, textureBasePointer, tbw, mipWidth, mipHeight,
                        paletteBasePointer, -1,
                    );
                levels.push(pixels);
                mipPixelOffset += mipBytes;
            }
        } else if (psm === GSPixelStorageFormat.PSMCT32) {
            for (let level = 0; level < mipCount; level++) {
                const mipWidth = Math.max(1, width >>> level);
                const mipHeight = Math.max(1, height >>> level);
                const mipBytes = mipWidth * mipHeight * 4;
                if (mipPixelOffset + mipBytes > offset + paletteOffset) break;
                const pixels = new Uint8Array(mipBytes);
                for (let i = 0; i < mipWidth * mipHeight; i++) {
                    const src = mipPixelOffset + i * 4;
                    pixels.set(payload.subarray(src, src + 4), i * 4);
                    pixels[i * 4 + 3] = Math.min(0xFF, pixels[i * 4 + 3] * 2);
                }
                levels.push(pixels);
                mipPixelOffset += mipBytes;
            }
        } else { continue; }
        if (name.length !== 0 && levels.length !== 0 && !textures.has(name))
            textures.set(name, { name, width, height, pixels: levels[0], levels, alphaTest, alphaReference, alphaFail });
    }
    return [...textures.values()];
}
