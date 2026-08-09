import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { Color, colorNewFromRGBA } from '../Color.js';
import * as RDP from '../Common/N64/RDP.js';
import { RSP_Geometry, Vertex } from '../BanjoKazooie/f3dex.js';
import { TextFilt } from '../Common/N64/Image.js';
import { GfxBlendFactor } from '../gfx/platform/GfxPlatform.js';
import { DrawCall } from './render.js';
import type { LevelArchive, ModelArchive, RoomArchive } from './archive.js';
import { Fast3DOpcode, PropFlag, SetupType } from './constants.js';

function readVertex(view: DataView, offs: number, roomPosition: number[]): Vertex {
    const v = new Vertex();
    v.x = view.getInt16(offs) + roomPosition[0];
    v.y = view.getInt16(offs + 2) + roomPosition[1];
    v.z = view.getInt16(offs + 4) + roomPosition[2];
    v.tx = view.getInt16(offs + 8) / 32;
    v.ty = view.getInt16(offs + 10) / 32;
    v.c0 = view.getUint8(offs + 12) / 0xFF;
    v.c1 = view.getUint8(offs + 13) / 0xFF;
    v.c2 = view.getUint8(offs + 14) / 0xFF;
    v.a = view.getUint8(offs + 15) / 0xFF;
    return v;
}

function transformVertex(v: Vertex, matrix: number[]): Vertex {
    const x = v.x, y = v.y, z = v.z;
    v.x = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
    v.y = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
    v.z = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
    return v;
}

function cloneVertex(v: Vertex): Vertex {
    const copy = new Vertex();
    copy.x = v.x; copy.y = v.y; copy.z = v.z;
    copy.tx = v.tx; copy.ty = v.ty;
    copy.c0 = v.c0; copy.c1 = v.c1; copy.c2 = v.c2; copy.a = v.a;
    return copy;
}

interface MaterialBatch {
    textureID: number;
    detailTextureID: number;
    textureType: number;
    textureSMode: number;
    textureTMode: number;
    textureScaleS: number;
    textureScaleT: number;
    textureShiftS: number;
    textureShiftT: number;
    geometryMode: number;
    otherModeH: number;
    otherModeL: number;
    combineH: number;
    combineL: number;
    envColorWord: number;
    primColorWord: number;
    lodMin?: number;
    lodMax?: number;
    screenIndex?: number;
    bspPath?: { Index: number; Side: number }[];
    vertices: Vertex[];
}

export interface GoldenEyeDrawCall {
    drawCall: DrawCall;
    textureID: number;
    detailTextureID: number;
    textureType: number;
    textureSMode: number;
    textureTMode: number;
    modelID: number;
    lodMin?: number;
    lodMax?: number;
    screenIndex?: number;
    screenMatrix?: number[];
    sortPosition?: number[];
    bspPath?: { Index: number; Side: number }[];
    variant?: string;
    roomIndex?: number;
    roomPhase?: 'primary' | 'secondary';
}

const monitorTextureIDs = [
    2187, 2188, 2189, 2190, 2191, 2192, 2193, 2194, 2195, 2196, 2197, 1185,
    2198, 2199, 1186, 1187, 2200, 582, 583, 584, 2201, 2202, 2203, 2204, 581,
    2205, 2206, 2227, 2223, 2224, 2225, 2226, 2219, 2220, 2221, 2222, 2218,
    2207, 2208, 2209, 2210, 2211, 2212, 2213, 2214, 2215, 2216, 2217, 2263, 837,
];

function colorFromWord(word: number): Color {
    return colorNewFromRGBA(((word >>> 24) & 0xFF) / 0xFF, ((word >>> 16) & 0xFF) / 0xFF, ((word >>> 8) & 0xFF) / 0xFF, (word & 0xFF) / 0xFF);
}

function materialKey(batch: Omit<MaterialBatch, 'vertices'>): string {
    return `${batch.textureID}/${batch.detailTextureID}/${batch.textureType}/${batch.textureSMode}/${batch.textureTMode}/${batch.textureScaleS}/${batch.textureScaleT}/${batch.textureShiftS}/${batch.textureShiftT}/${batch.geometryMode}/${batch.otherModeH}/${batch.otherModeL}/${batch.combineH}/${batch.combineL}/${batch.envColorWord}/${batch.primColorWord}/${batch.lodMin ?? ''}/${batch.lodMax ?? ''}/${batch.screenIndex ?? ''}/${batch.bspPath?.map((v) => `${v.Index}:${v.Side}`).join(',') ?? ''}`;
}

function textureShiftScale(shift: number): number {
    return shift <= 10 ? 1 / (1 << shift) : 1 << (16 - shift);
}

function vertexForGeometryMode(v: Vertex, geometryMode: number): Vertex {
    if ((geometryMode & RSP_Geometry.G_LIGHTING) === 0)
        return v;
    const result = new Vertex();
    result.x = v.x; result.y = v.y; result.z = v.z;
    result.tx = v.tx; result.ty = v.ty; result.a = v.a;
    const signed = (n: number): number => {
        const b = Math.round(n * 0xFF);
        return (b >= 0x80 ? b - 0x100 : b) / 0x7F;
    };
    result.c0 = signed(v.c0); result.c1 = signed(v.c1); result.c2 = signed(v.c2);
    return result;
}

function appendRoomDisplayList(batches: Map<string, MaterialBatch>, room: RoomArchive, dl: ArrayBufferSlice): void {
    if (dl.byteLength === 0)
        return;
    const vertices = room.Vertices.createDataView();
    const commands = dl.createDataView();
    const cache: (Vertex | null)[] = new Array(16).fill(null);
    let textureID = -1;
    let detailTextureID = -1;
    let textureType = 0;
    let textureSMode = 0, textureTMode = 0;
    let textureScaleS = 1, textureScaleT = 1;
    let textureShiftS = 0, textureShiftT = 0;
    let geometryMode = RSP_Geometry.G_ZBUFFER | RSP_Geometry.G_SHADE | RSP_Geometry.G_SHADING_SMOOTH;
    let otherModeH = 0;
    let otherModeL = RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF2;
    let combineH = 0x121624, combineL = 0xFF2FFFFF;
    let envColorWord = 0xFFFFFFFF, primColorWord = 0xFFFFFFFF;
    const emit = (a: number, b: number, c: number): void => {
        if (a === b && b === c)
            return;
        const va = cache[a], vb = cache[b], vc = cache[c];
        if (va !== null && vb !== null && vc !== null) {
            // Preserve all C0 material state in the batch key. Types 0-4 are
            // dispatched separately by texLoadFromGdl in the original game.
            const state = { textureID, detailTextureID, textureType, textureSMode, textureTMode, textureScaleS, textureScaleT, textureShiftS, textureShiftT, geometryMode, otherModeH, otherModeL, combineH, combineL, envColorWord, primColorWord };
            const key = materialKey(state);
            let batch = batches.get(key);
            if (batch === undefined) {
                batch = { ...state, vertices: [] };
                batches.set(key, batch);
            }
            batch.vertices.push(vertexForGeometryMode(va, geometryMode), vertexForGeometryMode(vb, geometryMode), vertexForGeometryMode(vc, geometryMode));
        }
    };

    for (let offs = 0; offs + 8 <= commands.byteLength; offs += 8) {
        const w0 = commands.getUint32(offs);
        const w1 = commands.getUint32(offs + 4);
        const op = w0 >>> 24;
        if (op === Fast3DOpcode.GoldenEyeTexture) {
            textureID = w1 & 0x0FFF;
            textureType = w0 & 0x07;
            textureSMode = (w0 >>> 22) & 0x03;
            textureTMode = (w0 >>> 20) & 0x03;
            textureShiftS = (w0 >>> 14) & 0x0F;
            textureShiftT = (w0 >>> 10) & 0x0F;
            detailTextureID = textureType === 1 ? (w1 >>> 12) & 0x0FFF : -1;
        } else if (op === Fast3DOpcode.ClearGeometryMode) {
            geometryMode &= ~w1;
        } else if (op === Fast3DOpcode.SetGeometryMode) {
            geometryMode |= w1;
        } else if (op === Fast3DOpcode.SetOtherModeLow) {
            otherModeL = w1;
        } else if (op === Fast3DOpcode.SetOtherModeHigh) {
            const shift = (w0 >>> 8) & 0xFF, length = w0 & 0xFF;
            const mask = length >= 32 ? 0xFFFFFFFF : (((1 << length) - 1) << shift);
            otherModeH = (otherModeH & ~mask) | (w1 & mask);
        } else if (op === Fast3DOpcode.Texture) {
            textureScaleS = ((w1 >>> 16) & 0xFFFF) / 0x10000;
            textureScaleT = (w1 & 0xFFFF) / 0x10000;
        } else if (op === Fast3DOpcode.SetPrimColor) {
            primColorWord = w1;
        } else if (op === Fast3DOpcode.SetEnvColor) {
            envColorWord = w1;
        } else if (op === Fast3DOpcode.SetCombine) {
            combineH = w0 & 0x00FFFFFF;
            combineL = w1;
        } else if (op === Fast3DOpcode.Vertex) {
            // GoldenEye uses the original Fast3D VTX encoding:
            // high parameter nibble is n-1, low nibble is v0.
            const n = ((w0 >>> 20) & 0x0F) + 1;
            const v0 = (w0 >>> 16) & 0x0F;
            const address = w1 & 0x00FFFFFF;
            for (let i = 0; i < n; i++) {
                const vertexOffs = address + i * 0x10;
                if (v0 + i < cache.length && vertexOffs + 0x10 <= vertices.byteLength)
                    cache[v0 + i] = readVertex(vertices, vertexOffs, room.Position);
            }
        } else if (op === Fast3DOpcode.Triangle2) {
            // Rare's TRI4 extension packs four triangles into twelve nibbles.
            const zs = [w0 & 0xF, (w0 >>> 4) & 0xF, (w0 >>> 8) & 0xF, (w0 >>> 12) & 0xF];
            for (let i = 0; i < 4; i++)
                emit((w1 >>> (i * 8)) & 0xF, (w1 >>> (i * 8 + 4)) & 0xF, zs[i]);
        } else if (op === Fast3DOpcode.Triangle1) {
            emit(((w1 >>> 16) & 0xFF) / 10, ((w1 >>> 8) & 0xFF) / 10, (w1 & 0xFF) / 10);
        } else if (op === Fast3DOpcode.EndDisplayList) {
            break;
        }
    }
}

export function buildLevelDrawCalls(archive: LevelArchive): GoldenEyeDrawCall[] {
    const result: GoldenEyeDrawCall[] = [];
    const appendResult = (batch: MaterialBatch, sortPosition: number[] | undefined, roomIndex: number, roomPhase: 'primary' | 'secondary'): void => {
        const drawCall = new DrawCall();
        drawCall.SP_GeometryMode = batch.geometryMode;
        drawCall.DP_OtherModeH = batch.otherModeH;
        drawCall.DP_OtherModeL = batch.otherModeL;
        drawCall.DP_Combine = RDP.decodeCombineParams(batch.combineH, batch.combineL);
        drawCall.DP_EnvColor = colorFromWord(batch.envColorWord);
        drawCall.DP_PrimColor = colorFromWord(batch.primColorWord);
        drawCall.vertices = batch.vertices;
        drawCall.vertexCount = batch.vertices.length;
        drawCall.SP_TextureState.set(true, 0, 0, batch.textureScaleS, batch.textureScaleT);
        if (batch.textureType === 0 || batch.textureType === 1)
            drawCall.textureScaleOverrides[0] = [textureShiftScale(batch.textureShiftS), textureShiftScale(batch.textureShiftT)];
        result.push({ drawCall, textureID: batch.textureID, detailTextureID: batch.detailTextureID, textureType: batch.textureType, textureSMode: batch.textureSMode, textureTMode: batch.textureTMode, modelID: -1, sortPosition, roomIndex, roomPhase });
    };
    for (const room of archive.Rooms) {
        // The cartridge submits each room's primary and secondary streams in
        // visibility order. Keeping them separate prevents translucent state
        // from being globally merged across unrelated rooms/material runs.
        for (const [displayList, roomPhase] of [[room.PrimaryDisplayList, 'primary'], [room.SecondaryDisplayList, 'secondary']] as const) {
            const batches = new Map<string, MaterialBatch>();
            appendRoomDisplayList(batches, room, displayList);
            for (const batch of batches.values()) {
                const blend = RDP.translateRenderMode(batch.otherModeL).attachmentsState?.[0]?.rgbBlendState;
                const translucent = blend !== undefined && blend.blendDstFactor !== GfxBlendFactor.Zero;
                appendResult(batch, translucent ? room.Center ?? room.Position : undefined, room.Index, roomPhase);
            }
        }
    }
    return result;
}

function appendModelDisplayLists(batches: Map<string, MaterialBatch>, model: ModelArchive, vertexOverrides?: Map<number, Vertex>): void {
    const data = model.Data.createDataView();
    const cache: (Vertex | null)[] = new Array(16).fill(null);
    let textureID = -1;
    let detailTextureID = -1;
    let textureType = 0;
    let textureSMode = 0, textureTMode = 0;
    let textureScaleS = 1, textureScaleT = 1;
    let textureShiftS = 0, textureShiftT = 0;
    let geometryMode = RSP_Geometry.G_ZBUFFER | RSP_Geometry.G_SHADE | RSP_Geometry.G_SHADING_SMOOTH;
    let otherModeH = 0;
    let otherModeL = RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF2;
    let combineH = 0x121624, combineL = 0xFF2FFFFF;
    let envColorWord = 0xFFFFFFFF, primColorWord = 0xFFFFFFFF;
    let lodMin: number | undefined, lodMax: number | undefined, screenIndex: number | undefined;
    let bspPath: { Index: number; Side: number }[] | undefined;
    const applyModelSetup = (modelType: number, secondary: boolean): void => {
        if (modelType === 0)
            return;
        // modelRenderNodeGundl emits these states immediately before the
        // archived display list. Static world props take the ordinary fallback
        // path in modelApplyRenderModeType3/4; their secondary stream is the
        // translucent pass. Individual commands may still override this state.
        if (modelType === 1) {
            otherModeH = (otherModeH & ~0x00300000) >>> 0;
            otherModeL = 0x00552078;
            combineH = 0x121824; combineL = 0xFF33FFFF;
        } else if (modelType === 2) {
            otherModeH = ((otherModeH & ~0x00300000) | 0x00100000) >>> 0;
            otherModeL = 0x0C192078;
            combineH = 0x26A004; combineL = 0x1F1093FF;
        } else if (modelType === 3 || modelType === 4) {
            otherModeH = ((otherModeH & ~0x00300000) | 0x00100000) >>> 0;
            otherModeL = secondary ? 0xC41049D8 : 0xC4112078;
            combineH = 0x26A004; combineL = 0x1F1093FF;
        }
    };
    const emit = (a: number, b: number, c: number): void => {
        if (a === b && b === c)
            return;
        const va = cache[a], vb = cache[b], vc = cache[c];
        if (va === null || vb === null || vc === null)
            return;
        const state = { textureID, detailTextureID, textureType, textureSMode, textureTMode, textureScaleS, textureScaleT, textureShiftS, textureShiftT, geometryMode, otherModeH, otherModeL, combineH, combineL, envColorWord, primColorWord, lodMin, lodMax, screenIndex, bspPath };
        const key = materialKey(state);
        let batch = batches.get(key);
        if (batch === undefined) {
            batch = { ...state, vertices: [] };
            batches.set(key, batch);
        }
        batch.vertices.push(vertexForGeometryMode(va, geometryMode), vertexForGeometryMode(vb, geometryMode), vertexForGeometryMode(vc, geometryMode));
    };
    const active = new Set<string>();
    const run = (start: number, vertexBase: number, matrix: number[]): number[] => {
        const activeKey = `${start}/${matrix.join('/')}/${lodMin ?? ''}/${lodMax ?? ''}`;
        if (start < 0 || start >= data.byteLength || active.has(activeKey))
            return matrix;
        active.add(activeKey);
        let currentMatrix = matrix;
        for (let offs = start; offs + 8 <= data.byteLength; offs += 8) {
            const w0 = data.getUint32(offs), w1 = data.getUint32(offs + 4);
            const op = w0 >>> 24;
            if (op === Fast3DOpcode.Matrix) {
                // Character display lists load entries from the render_pos
                // matrix array through segment 3, often switching joints
                // between vertex loads in one list.
                if ((w1 >>> 24) === 3) {
                    const matrix = model.Matrices[(w1 & 0x00FFFFFF) >>> 6];
                    if (matrix != null)
                        currentMatrix = matrix;
                }
            } else if (op === Fast3DOpcode.GoldenEyeTexture) {
                textureID = w1 & 0x0FFF;
                textureType = w0 & 7;
                textureSMode = (w0 >>> 22) & 0x03;
                textureTMode = (w0 >>> 20) & 0x03;
                textureShiftS = (w0 >>> 14) & 0x0F;
                textureShiftT = (w0 >>> 10) & 0x0F;
                detailTextureID = textureType === 1 ? (w1 >>> 12) & 0x0FFF : -1;
            } else if (op === Fast3DOpcode.ClearGeometryMode) {
                geometryMode &= ~w1;
            } else if (op === Fast3DOpcode.SetGeometryMode) {
                geometryMode |= w1;
            } else if (op === Fast3DOpcode.SetOtherModeLow) {
                otherModeL = w1;
            } else if (op === Fast3DOpcode.SetOtherModeHigh) {
                const shift = (w0 >>> 8) & 0xFF, length = w0 & 0xFF;
                const mask = length >= 32 ? 0xFFFFFFFF : (((1 << length) - 1) << shift);
                otherModeH = (otherModeH & ~mask) | (w1 & mask);
            } else if (op === Fast3DOpcode.Texture) {
                textureScaleS = ((w1 >>> 16) & 0xFFFF) / 0x10000;
                textureScaleT = (w1 & 0xFFFF) / 0x10000;
            } else if (op === Fast3DOpcode.SetPrimColor) {
                primColorWord = w1;
            } else if (op === Fast3DOpcode.SetEnvColor) {
                envColorWord = w1;
            } else if (op === Fast3DOpcode.SetCombine) {
                combineH = w0 & 0x00FFFFFF;
                combineL = w1;
            } else if (op === Fast3DOpcode.Vertex) {
                const n = ((w0 >>> 20) & 0x0F) + 1;
                const v0 = (w0 >>> 16) & 0x0F;
                const address = ((w1 >>> 24) === 4 ? vertexBase : 0) + (w1 & 0x00FFFFFF);
                for (let i = 0; i < n; i++) {
                    const vertexOffs = address + i * 0x10;
                    if (v0 + i < cache.length && vertexOffs + 0x10 <= data.byteLength) {
                        const override = vertexOverrides?.get(vertexOffs);
                        const vertex = override === undefined ? readVertex(data, vertexOffs, [0, 0, 0]) : cloneVertex(override);
                        cache[v0 + i] = transformVertex(vertex, currentMatrix);
                    }
                }
            } else if (op === Fast3DOpcode.Triangle2) {
                const zs = [w0 & 0xF, (w0 >>> 4) & 0xF, (w0 >>> 8) & 0xF, (w0 >>> 12) & 0xF];
                for (let i = 0; i < 4; i++)
                    emit((w1 >>> (i * 8)) & 0xF, (w1 >>> (i * 8 + 4)) & 0xF, zs[i]);
            } else if (op === Fast3DOpcode.Triangle1) {
                emit(((w1 >>> 16) & 0xFF) / 10, ((w1 >>> 8) & 0xFF) / 10, (w1 & 0xFF) / 10);
            } else if (op === Fast3DOpcode.DisplayList) {
                currentMatrix = run(w1 & 0x00FFFFFF, vertexBase, currentMatrix);
                if ((w0 & 1) !== 0)
                    break;
            } else if (op === Fast3DOpcode.EndDisplayList) {
                break;
            }
        }
        active.delete(activeKey);
        return currentMatrix;
    };
    for (const dl of model.DisplayLists) {
        lodMin = dl.LODMin;
        lodMax = dl.LODMax;
        screenIndex = dl.ScreenIndex;
        bspPath = dl.BSPPath;
        applyModelSetup(dl.ModelType ?? 0, dl.Secondary ?? false);
        run(dl.Offset, dl.VertexBase, dl.Matrix);
    }
}

function buildDoorClipOverrides(model: ModelArchive, doorType: number, openPosition: number): Map<number, Vertex> | undefined {
    const clip = model.DoorClip, bounds = model.Bounds;
    if (clip == null || bounds == null || clip.VertexCount < 4)
        return undefined;
    const vertical = doorType === 4;
    const cutoff = vertical
        ? bounds[3] + (bounds[2] - bounds[3]) * openPosition
        : bounds[0] + (bounds[1] - bounds[0]) * openPosition;
    const data = model.Data.createDataView();
    const result = new Map<number, Vertex>();
    for (let base = 0; base + 3 < clip.VertexCount; base += 4) {
        const source = [0, 1, 2, 3].map((i) => readVertex(data, clip.VertexBase + (base + i) * 0x10, [0, 0, 0]));
        const output = source.map(cloneVertex);
        for (let j = 0; j < 4; j++) {
            const value = vertical ? source[j].y : source[j].x;
            const clipped = vertical ? value >= cutoff : value <= cutoff;
            if (!clipped)
                continue;
            let neighbor: Vertex | undefined;
            for (const delta of [1, 2, 3]) {
                const candidate = source[(j + delta) & 3];
                if (vertical
                    ? candidate.x === source[j].x && candidate.z === source[j].z && candidate.y !== source[j].y
                    : candidate.y === source[j].y && candidate.z === source[j].z && candidate.x !== source[j].x) {
                    neighbor = candidate;
                    break;
                }
            }
            if (neighbor !== undefined) {
                const denominator = vertical ? value - neighbor.y : neighbor.x - value;
                const numerator = vertical ? value - cutoff : cutoff - value;
                const t = numerator / denominator;
                output[j].tx = source[j].tx + t * (neighbor.tx - source[j].tx);
                output[j].ty = source[j].ty + t * (neighbor.ty - source[j].ty);
            }
            if (vertical) output[j].y = cutoff;
            else output[j].x = cutoff;
        }
        for (let j = 0; j < 4; j++)
            result.set(clip.VertexBase + (base + j) * 0x10, output[j]);
    }
    return result;
}

export function buildModelDrawCalls(archive: LevelArchive): GoldenEyeDrawCall[] {
    const result: GoldenEyeDrawCall[] = [];
    const textureSizes = new Map(archive.Textures.map((texture) => [texture.ID, [texture.Width, texture.Height] as const]));
    const appendBatches = (model: ModelArchive, variant?: string, overrides?: Map<number, Vertex>): void => {
        const batches = new Map<string, MaterialBatch>();
        appendModelDisplayLists(batches, model, overrides);
        for (const batch of batches.values()) {
            const drawCall = new DrawCall();
            drawCall.SP_GeometryMode = batch.geometryMode;
            drawCall.DP_OtherModeH = batch.otherModeH;
            drawCall.DP_OtherModeL = batch.otherModeL;
            drawCall.DP_Combine = RDP.decodeCombineParams(batch.combineH, batch.combineL);
            drawCall.DP_EnvColor = colorFromWord(batch.envColorWord);
            drawCall.DP_PrimColor = colorFromWord(batch.primColorWord);
            drawCall.vertices = batch.vertices;
            drawCall.vertexCount = batch.vertices.length;
            drawCall.SP_TextureState.set(true, 0, 0, batch.textureScaleS, batch.textureScaleT);
            drawCall.normalizedTextureCoordinates = batch.screenIndex !== undefined;
            if (batch.textureType === 0 || batch.textureType === 1)
                drawCall.textureScaleOverrides[0] = [textureShiftScale(batch.textureShiftS), textureShiftScale(batch.textureShiftT)];
            result.push({ drawCall, textureID: batch.textureID, detailTextureID: batch.detailTextureID, textureType: batch.textureType, textureSMode: batch.textureSMode, textureTMode: batch.textureTMode, modelID: model.ID, lodMin: batch.lodMin, lodMax: batch.lodMax, screenIndex: batch.screenIndex, bspPath: batch.bspPath, variant });
        }
    };
    for (const model of [...(archive.Models ?? []), ...(archive.Characters ?? []), ...(archive.Heads ?? [])]) {
        appendBatches(model);
        for (const shadow of model.Shadows ?? []) {
            const [width, height] = textureSizes.get(shadow.TextureID) ?? [1, 1];
            const [px, py] = shadow.Position, [sx, sy] = shadow.Size;
            const makeVertex = (x: number, z: number, tx: number, ty: number): Vertex => {
                const v = new Vertex();
                // doshadow's two rodata coordinates describe the footprint;
                // its runtime matrix/ground-height path projects that footprint
                // onto the floor. In the viewer's Y-up model basis this is XZ.
                v.x = x; v.y = 0.5; v.z = z;
                v.tx = tx; v.ty = ty;
                // modelSetShadowOpacity defaults to 0x50. The texture supplies
                // the radial silhouette while vertex alpha supplies opacity.
                v.c0 = v.c1 = v.c2 = 1; v.a = 0x50 / 0xFF;
                return transformVertex(v, shadow.Matrix);
            };
            const a = makeVertex(px - sx, py - sy, 0, 0);
            const b = makeVertex(px - sx, py + sy, 0, height);
            const c = makeVertex(px + sx, py + sy, width, height);
            const d = makeVertex(px + sx, py - sy, width, 0);
            const drawCall = new DrawCall();
            drawCall.SP_GeometryMode = RSP_Geometry.G_ZBUFFER | RSP_Geometry.G_SHADE | RSP_Geometry.G_SHADING_SMOOTH;
            drawCall.DP_OtherModeH = TextFilt.G_TF_BILERP << RDP.OtherModeH_Layout.G_MDSFT_TEXTFILT;
            drawCall.DP_OtherModeL = RDP.RENDER_MODES.G_RM_AA_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_AA_ZB_XLU_SURF2;
            drawCall.DP_Combine = RDP.decodeCombineParams(0x00121624, 0xFF2FFFFF);
            drawCall.vertices = [a, b, c, a, c, d];
            drawCall.vertexCount = 6;
            drawCall.SP_TextureState.set(true, 0, 0, 1, 1);
            result.push({ drawCall, textureID: shadow.TextureID, detailTextureID: -1, textureType: 0, textureSMode: 1, textureTMode: 1, modelID: model.ID });
        }
        for (const screen of model.Screens ?? []) {
            const data = model.Data.createDataView();
            const corners: Vertex[] = [];
            for (let i = 0; i < 4; i++) {
                const v = readVertex(data, screen.VertexBase + i * 0x10, [0, 0, 0]);
                v.tx = i === 0 || i === 3 ? 1 : 0;
                v.ty = i === 0 || i === 1 ? 1 : 0;
                v.c0 = v.c1 = v.c2 = v.a = 1;
                corners.push(transformVertex(v, screen.Matrix));
            }
            const drawCall = new DrawCall();
            drawCall.SP_GeometryMode = RSP_Geometry.G_ZBUFFER | RSP_Geometry.G_SHADE | RSP_Geometry.G_SHADING_SMOOTH;
            drawCall.DP_OtherModeH = TextFilt.G_TF_BILERP << RDP.OtherModeH_Layout.G_MDSFT_TEXTFILT;
            drawCall.DP_OtherModeL = RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF2;
            drawCall.DP_Combine = RDP.decodeCombineParams(0x00121624, 0xFF2FFFFF);
            drawCall.vertices = [corners[0], corners[1], corners[2], corners[0], corners[2], corners[3]];
            drawCall.vertexCount = 6;
            drawCall.SP_TextureState.set(true, 0, 0, 1, 1);
            drawCall.normalizedTextureCoordinates = true;
            result.push({ drawCall, textureID: 2187, detailTextureID: -1, textureType: 0, textureSMode: 0, textureTMode: 0, modelID: model.ID, screenIndex: screen.Index, screenMatrix: screen.Matrix });
        }
    }
    const modelsByID = new Map((archive.Models ?? []).map((model) => [model.ID, model] as const));
    const variants = new Set<string>();
    for (const prop of archive.Props ?? []) {
        if (prop.Type !== SetupType.Door || prop.Flags == null || (prop.Flags & PropFlag.InitiallyOpen) === 0
                || prop.DoorFlags == null || (prop.DoorFlags & 4) === 0
                || prop.DoorType == null || prop.MaxOpenFraction == null)
            continue;
        const model = modelsByID.get(prop.ModelID);
        if (model === undefined)
            continue;
        const variant = `doorclip:${prop.DoorType}:${prop.MaxOpenFraction}`;
        const key = `${model.ID}/${variant}`;
        if (variants.has(key))
            continue;
        variants.add(key);
        const overrides = buildDoorClipOverrides(model, prop.DoorType, prop.MaxOpenFraction);
        if (overrides !== undefined)
            appendBatches(model, variant, overrides);
    }
    return result;
}

