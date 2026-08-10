import { mat4, vec3, vec4 } from 'gl-matrix';
import { decompress } from 'fzstd';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import * as BYML from '../byml.js';
import { CameraController } from '../Camera.js';
import * as RDP from '../Common/N64/RDP.js';
import { TexCM, TextFilt } from '../Common/N64/Image.js';
import { RSP_Geometry, Vertex } from '../BanjoKazooie/f3dex.js';
import { bindingLayouts, DrawCall, DrawCallInstance, DrawCallRenderData, SceneLighting } from './render.js';
import { F3DEX_Program } from '../BanjoKazooie/render.js';
import { fillMatrix4x4, fillVec4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { makeAttachmentClearDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { GfxRendererLayer, GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { GfxCompareMode, GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { SceneContext } from '../SceneBase.js';
import * as Viewer from '../viewer.js';
import { colorNewFromRGBA, Color } from '../Color.js';
import { AABB } from '../Geometry.js';
import * as UI from '../ui.js';
import type { EnvironmentArchive, LevelArchive, ModelArchive, PortalArchive, PropArchive, RoomArchive, TextureArchive } from './archive.js';
import { PropFlag, SetupType } from './constants.js';
import { buildLevelDrawCalls, buildModelDrawCalls } from './display_list.js';
import type { GoldenEyeDrawCall } from './display_list.js';
import { buildEnvironmentDrawCalls, environmentFromArchive, getFogRange, MonitorAnimator, updateEnvironmentPolygon } from './effects.js';
import type { Environment } from './effects.js';
import { makePropMatrix, transformBounds } from './placement.js';

const environmentViewScratch = mat4.create();
const environmentShearScratch = mat4.create();
const environmentWorldScratch = mat4.create();

type PortalWindow = [number, number, number, number];

interface StanTile {
    roomIndex: number;
    points: [number, number][];
}

function parseStanTiles(data: ArrayBufferSlice): StanTile[] {
    const view = data.createDataView();
    if (view.byteLength < 12)
        return [];
    const tiles: StanTile[] = [];
    const sizes = [0x20, 0x20, 0x20, 0x20, 0x28, 0x30, 0x38, 0x40, 0x48, 0x50, 0x58];
    for (let offs = view.getUint32(4) & 0x00FFFFFF; offs + 8 <= view.byteLength && view.getUint32(offs) !== 0;) {
        const tail = view.getUint16(offs + 6);
        const count = (tail & 0x0F) + 1;
        const points: [number, number][] = [];
        for (let i = 0; i < count && offs + 14 + i * 8 <= view.byteLength; i++)
            points.push([view.getInt16(offs + 8 + i * 8), view.getInt16(offs + 12 + i * 8)]);
        if (points.length >= 3)
            tiles.push({ roomIndex: view.getUint8(offs + 3), points });
        const size = sizes[(tail >>> 12) & 0x0F];
        if (size === undefined)
            break;
        offs += size;
    }
    return tiles;
}

function pointInStanTile(x: number, z: number, tile: StanTile): boolean {
    let inside = false;
    for (let i = 0, j = tile.points.length - 1; i < tile.points.length; j = i++) {
        const a = tile.points[i], b = tile.points[j];
        const cross = (x - a[0]) * (b[1] - a[1]) - (z - a[1]) * (b[0] - a[0]);
        const dot = (x - a[0]) * (x - b[0]) + (z - a[1]) * (z - b[1]);
        if (Math.abs(cross) < 0.001 && dot <= 0)
            return true;
        if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0])
            inside = !inside;
    }
    return inside;
}
function buildTextureCache(archive: LevelArchive): { cache: RDP.TextureCache; indices: Map<number, number>; lod1Indices: Map<number, number> } {
    const cache = new RDP.TextureCache();
    const indices = new Map<number, number>();
    const lod1Indices = new Map<number, number>();
    for (const texture of archive.Textures) {
        const tile = new RDP.TileState();
        tile.cacheKey = texture.ID + 1;
        tile.cms = tile.cmt = TexCM.WRAP;
        tile.setSize(0, 0, (texture.Width - 1) << 2, (texture.Height - 1) << 2);
        indices.set(texture.ID, cache.textures.length);
        const rdpTexture = new RDP.Texture(tile, texture.ID, 0, texture.Width, texture.Height, texture.Pixels.createTypedArray(Uint8Array));
        rdpTexture.name = `GoldenEye texture ${texture.ID}`;
        cache.textures.push(rdpTexture);
        if (texture.LOD1Pixels != null && texture.LOD1Width != null && texture.LOD1Height != null) {
            const lodTile = new RDP.TileState();
            lodTile.cacheKey = 0x10000 + texture.ID;
            lodTile.cms = lodTile.cmt = TexCM.WRAP;
            lodTile.setSize(0, 0, (texture.LOD1Width - 1) << 2, (texture.LOD1Height - 1) << 2);
            lod1Indices.set(texture.ID, cache.textures.length);
            const lodTexture = new RDP.Texture(lodTile, texture.ID, 1, texture.LOD1Width, texture.LOD1Height, texture.LOD1Pixels.createTypedArray(Uint8Array));
            lodTexture.name = `GoldenEye texture ${texture.ID} LOD 1`;
            cache.textures.push(lodTexture);
        }
    }
    return { cache, indices, lod1Indices };
}



export class GoldenEyeRenderer implements Viewer.SceneGfx {
    private renderHelper: GfxRenderHelper;
    private renderInstList = new GfxRenderInstList();
    private drawCalls: DrawCall[];
    private drawCallInstances: { instance: DrawCallInstance; matrix: mat4; kind: 'background' | 'prop' | 'guard'; environmentKind?: number; drawCall?: DrawCall; roomIndex?: number; roomIndices?: number[]; roomPhase?: 'primary' | 'secondary'; glass?: { position: number[]; near: number; far: number; minimum: number }; bsp?: { path: { Index: number; Side: number }[]; planes: NonNullable<ModelArchive['BSPPlanes']> } }[];
    private environment: Environment | undefined;
    private sceneLighting = new SceneLighting();
    private monitorBindings: { instance: DrawCallInstance; animator: MonitorAnimator; zMode: number }[] = [];
    private textureIndices = new Map<number, number>();
    private defaultWorldMatrix = mat4.create();
    private stanTiles: StanTile[];
    private roomBounds = new Map<number, AABB>();
    private fogInstances: DrawCallInstance[] = [];
    private roomVisibilityEnabled = true;
    private regressionDisablePortalCulling = false;
    private propsVisible = true;
    private guardsVisible = true;
    private portalsVisible = false;
    private roomRenderInstLists: { primary: GfxRenderInstList; secondary: GfxRenderInstList; bounds: PortalWindow }[] = [];
    private unscissoredRoomPrimary = new GfxRenderInstList();
    private unscissoredRoomSecondary = new GfxRenderInstList();

    constructor(device: GfxDevice, private archive: LevelArchive) {
        this.renderHelper = new GfxRenderHelper(device);
        this.stanTiles = parseStanTiles(archive.Stan);
        for (const room of archive.Rooms) {
            const b = room.Bounds;
            if (b !== undefined)
                this.roomBounds.set(room.Index, new AABB(b[0], b[1], b[2], b[3], b[4], b[5]));
        }
        this.sceneLighting.ambientColor = vec3.fromValues(150 / 255, 150 / 255, 150 / 255);
        this.sceneLighting.diffuseColor.push(vec3.fromValues(1, 1, 1));
        const lightLength = Math.hypot(77, 77, 46);
        this.sceneLighting.diffuseDirection.push(vec3.fromValues(77 / lightLength, 77 / lightLength, 46 / lightLength));
        this.environment = environmentFromArchive(archive.Environment);
        if (archive.InitialCamera != null) {
            const p = archive.InitialCamera.Position, look = archive.InitialCamera.Look;
            // Player/camera dimensions live in canonical model units and are
            // converted to the raw BG coordinate system by the stage scale,
            // just like guards and props. A fixed raw offset puts Bond high in
            // low-scale stages such as Jungle and too low in Facility.
            const eyeHeight = 160 * archive.Scale;
            const eye = vec3.fromValues(p[0], p[1] + eyeHeight, p[2]);
            const target = vec3.fromValues(eye[0] + look[0] * 500, eye[1] + look[1] * 500, eye[2] + look[2] * 500);
            const up = vec3.fromValues(...archive.InitialCamera.Up as [number, number, number]);
            mat4.targetTo(this.defaultWorldMatrix, eye, target, up);
        } else {
            const eyeHeight = 160 * archive.Scale;
            const candidates = archive.Rooms.flatMap((room) => {
                const b = room.Bounds;
                if (b === undefined) return [];
                const sx = b[3] - b[0], sy = b[4] - b[1], sz = b[5] - b[2];
                if (sx < eyeHeight * 1.5 || sy < eyeHeight || sz < eyeHeight * 1.5) return [];
                const adjacent = (archive.Portals ?? []).filter((portal) => portal.Room1 === room.Index || portal.Room2 === room.Index);
                return [{ room, b, sx, sy, sz, volume: sx * sy * sz, adjacent }];
            }).sort((a, b) => b.adjacent.length - a.adjacent.length || a.volume - b.volume);
            const selected = candidates[0];
            if (selected !== undefined) {
                const { b, sx, sy, sz } = selected;
                const eye = vec3.fromValues((b[0] + b[3]) * 0.5,
                    b[1] + Math.min(eyeHeight, sy * 0.45), (b[2] + b[5]) * 0.5);
                const target = vec3.clone(eye);
                const portal = selected.adjacent.sort((a, b) => {
                    const extent = (p: PortalArchive): number => {
                        const xs = p.Points.map((v) => v[0]), ys = p.Points.map((v) => v[1]), zs = p.Points.map((v) => v[2]);
                        const dx = Math.max(...xs) - Math.min(...xs), dy = Math.max(...ys) - Math.min(...ys), dz = Math.max(...zs) - Math.min(...zs);
                        return Math.max(dx * dy, dx * dz, dy * dz);
                    };
                    return extent(b) - extent(a);
                })[0];
                if (portal !== undefined) {
                    target[0] = portal.Points.reduce((sum, p) => sum + p[0], 0) / portal.Points.length;
                    target[2] = portal.Points.reduce((sum, p) => sum + p[2], 0) / portal.Points.length;
                } else if (sz >= sx) target[2] += Math.max(1, sz * 0.25);
                else target[0] += Math.max(1, sx * 0.25);
                mat4.targetTo(this.defaultWorldMatrix, eye, target, vec3.fromValues(0, 1, 0));
            } else {
                const [cx = 0, cy = 0, cz = 0] = archive.Rooms[0]?.Center ?? [];
                mat4.targetTo(this.defaultWorldMatrix, vec3.fromValues(cx, cy, cz),
                    vec3.fromValues(cx, cy, cz + 1), vec3.fromValues(0, 1, 0));
            }
        }
        const { cache: textureCache, indices, lod1Indices } = buildTextureCache(archive);
        this.textureIndices = indices;
        const monitorCommands = archive.MonitorAnimationData?.createDataView();
        const environmentDrawCalls = buildEnvironmentDrawCalls(this.environment, archive.Scale);
        const levelDrawCalls = buildLevelDrawCalls(archive);
        const modelDrawCalls = buildModelDrawCalls(archive);
        const allDrawCalls = [...environmentDrawCalls, ...levelDrawCalls, ...modelDrawCalls];
        this.drawCalls = allDrawCalls.map((v) => v.drawCall);
        let sharedGfxTextures: DrawCallRenderData['textures'] | undefined;
        for (const { drawCall, textureID, detailTextureID, textureType, textureSMode, textureTMode } of allDrawCalls) {
            drawCall.textureCache = textureCache;
            const textureIndex = indices.get(textureID);
            const detailTextureIndex = indices.get(detailTextureID);
            // texHandleType1 puts the high 12-bit image on tile/TEXEL0 and
            // the low 12-bit base image on tile/TEXEL1. Other C0 types bind
            // only the low image as TEXEL0. Type 2 installs adjacent LOD tiles
            // from the same image.
            if (textureType === 1) {
                if (detailTextureIndex !== undefined)
                    drawCall.textureIndices.push(detailTextureIndex);
                if (textureIndex !== undefined)
                    drawCall.textureIndices.push(textureIndex);
            } else if (textureType === 2 && textureIndex !== undefined) {
                drawCall.textureIndices.push(textureIndex, lod1Indices.get(textureID) ?? textureIndex);
            } else if (textureIndex !== undefined) {
                drawCall.textureIndices.push(textureIndex);
            }
            const renderData = new DrawCallRenderData(device, this.renderHelper.renderCache, textureCache, [], drawCall, sharedGfxTextures);
            if (sharedGfxTextures === undefined)
                sharedGfxTextures = renderData.textures;
            drawCall.renderData = renderData;
            const samplerBinding = textureType === 1 ? 1 : textureType >= 2 ? 0 : -1;
            const samplerTextureIndex = samplerBinding < 0 ? undefined : drawCall.textureIndices[samplerBinding];
            if (samplerTextureIndex !== undefined && (textureSMode !== 0 || textureTMode !== 0)) {
                const tile = new RDP.TileState();
                tile.copy(textureCache.textures[samplerTextureIndex].tile);
                const textureMode = (mode: number): TexCM => mode === 1 ? TexCM.CLAMP : mode === 2 ? TexCM.MIRROR : TexCM.WRAP;
                tile.cms = textureMode(textureSMode);
                tile.cmt = textureMode(textureTMode);
                renderData.samplers[samplerTextureIndex] = RDP.translateSampler(device, this.renderHelper.renderCache, { tile } as RDP.Texture);
            }
        }
        const makeInstance = ({ drawCall, modelID, lodMin, lodMax, sortPosition }: GoldenEyeDrawCall): DrawCallInstance => {
            const lights = (drawCall.SP_GeometryMode & RSP_Geometry.G_LIGHTING) !== 0 ? this.sceneLighting : null;
            const instance = new DrawCallInstance(drawCall, textureCache, lights);
            // modelUpdateDistanceRelations disconnects an LOD node's entire
            // affected subtree when its scaled distance range is inactive.
            // Extraction preserves that range on every flattened draw call in
            // the subtree, so the same test applies to characters and props.
            if (lodMax !== undefined)
                instance.setLODRange(lodMin ?? 0, lodMax);
            if (sortPosition !== undefined)
                instance.setSortPosition(sortPosition[0], sortPosition[1], sortPosition[2]);
            if (modelID <= -2) {
                instance.setDepthMode(false, GfxCompareMode.Always);
                instance.setSortLayer(GfxRendererLayer.BACKGROUND);
                // g_SkyCloudOffset advances by one 5-bit fixed texture unit
                // per 60 Hz game tick. DrawCallInstance expects normalized UV
                // units per second, so divide by both 32 and the 64px image.
                // Using absolute viewer time keeps the motion interpolated and
                // independent of a 60/120/144 Hz display refresh rate.
                const effectTextureSize = modelID === -3 ? 32 : 64;
                instance.setTextureScroll(0, 60 / (32 * effectTextureSize));
                if (modelID === -3) {
                    // water material phases: (0.25, 0.1) texel units/tick,
                    // with the second tile offset by (90, 150) 10.2 units.
                    instance.setTextureScroll(15 / (4 * 32), 60 / (32 * 32) + 6 / (4 * 32));
                    instance.setSecondTextureMotion(15 / (4 * 32), 60 / (32 * 32) + 6 / (4 * 32), 90 / (4 * 32), 150 / (4 * 32));
                }
            }
            const fogRange = this.environment === undefined ? null : getFogRange(this.environment, archive.VisibilityScale);
            if (modelID > -2 && fogRange !== null) {
                instance.setFog(fogRange[0] * archive.Scale, fogRange[1] * archive.Scale, this.environment!.sky);
                this.fogInstances.push(instance);
            }
            // Some BG batches use baked colours while others use these bytes as
            // normals. Keep them visible until the room-light records are wired.
            instance.setBackfaceCullingEnabled(false);
            return instance;
        };
        this.drawCallInstances = [...environmentDrawCalls, ...levelDrawCalls].map((call) => ({
            instance: makeInstance(call), matrix: mat4.create(),
            kind: 'background' as const,
            environmentKind: call.modelID <= -2 ? call.modelID : undefined,
            drawCall: call.modelID <= -2 ? call.drawCall : undefined,
            roomIndex: call.roomIndex,
            roomPhase: call.roomPhase,
        }));
        for (const entry of this.drawCallInstances) {
            if (entry.roomPhase === 'primary')
                entry.instance.setDepthMode(true, GfxCompareMode.GreaterEqual);
            else if (entry.roomPhase === 'secondary')
                entry.instance.setDepthMode(false, GfxCompareMode.GreaterEqual);
        }
        const callsByModel = new Map<string, GoldenEyeDrawCall[]>();
        for (const call of modelDrawCalls) {
            const key = `${call.modelID}/${call.variant ?? ''}`;
            let calls = callsByModel.get(key);
            if (calls === undefined)
                callsByModel.set(key, calls = []);
            calls.push(call);
        }
        // The cartridge renders BG coordinates through room_data_float2
        // (1 / level scale) and expands setup pads by the same factor. This
        // viewer keeps both files in their raw coordinate system, so model,
        // fog, and effect dimensions need the inverse transform: level scale.
        const canonicalModelScale = new Map([...(archive.Models ?? []), ...(archive.Characters ?? [])].map((model) => [model.ID, model.Scale]));
        const modelScale = new Map([...canonicalModelScale].map(([id, scale]) => [id, scale * archive.Scale]));
        const modelBounds = new Map([...(archive.Models ?? []), ...(archive.Characters ?? [])].flatMap((model) => model.Bounds == null ? [] : [[model.ID, model.Bounds] as const]));
        const placementBounds = new Map<number, number[]>();
        for (const call of modelDrawCalls) {
            if (call.variant !== undefined)
                continue;
            let bounds = placementBounds.get(call.modelID);
            if (bounds === undefined)
                placementBounds.set(call.modelID, bounds = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity]);
            for (const vertex of call.drawCall.vertices) {
                bounds[0] = Math.min(bounds[0], vertex.x); bounds[1] = Math.max(bounds[1], vertex.x);
                bounds[2] = Math.min(bounds[2], vertex.y); bounds[3] = Math.max(bounds[3], vertex.y);
                bounds[4] = Math.min(bounds[4], vertex.z); bounds[5] = Math.max(bounds[5], vertex.z);
            }
        }
        const characterAttachment = new Map((archive.Characters ?? []).flatMap((model) => model.AttachmentMatrix == null ? [] : [[model.ID, model.AttachmentMatrix] as const]));
        const characterAttachments = new Map((archive.Characters ?? []).map((model) => [model.ID, model.AttachmentMatrices ?? []] as const));
        const modelAttachments = new Map((archive.Models ?? []).map((model) => [model.ID, model.AttachmentMatrices ?? []] as const));
        const propsBySetupIndex = new Map((archive.Props ?? []).flatMap((prop) => prop.SetupIndex == null ? [] : [[prop.SetupIndex, prop] as const]));
        const propMatrices = new Map<number, mat4>();
        const bspPlanes = new Map([...(archive.Models ?? []), ...(archive.Characters ?? []), ...(archive.Heads ?? [])].map((model) => [model.ID, model.BSPPlanes ?? []] as const));
        const guardsByChrNum = new Map((archive.Guards ?? []).flatMap((guard) => guard.ChrNum == null ? [] : [[guard.ChrNum, guard] as const]));
        // Character archives contain a baked ANIM_idle frame, so guards use
        // the same setup-pad instance path as static props.
        const supportSurfaces: { bounds: number[]; roomIndex?: number }[] = [];
        let propIndex = 0;
        const sceneProps = [...(archive.Props ?? []), ...(archive.Guards ?? [])];
        sceneProps.sort((a, b) => Number(a.OwnerSetupIndex != null) - Number(b.OwnerSetupIndex != null));
        for (const prop of sceneProps) {
            if (prop.InitiallyHidden)
                continue;
            const instanceKind = prop.Type === SetupType.Guard || prop.ChrNum != null ? 'guard' as const : 'prop' as const;
            const clippedDoor = prop.Type === SetupType.Door && prop.Flags != null && (prop.Flags & PropFlag.InitiallyOpen) !== 0
                && prop.DoorFlags != null && (prop.DoorFlags & 4) !== 0
                && prop.DoorType != null && prop.MaxOpenFraction != null;
            const variant = clippedDoor ? `doorclip:${prop.DoorType}:${prop.MaxOpenFraction}` : '';
            const calls = callsByModel.get(`${prop.ModelID}/${variant}`) ?? callsByModel.get(`${prop.ModelID}/`);
            if (calls === undefined)
                continue;
            let matrix: mat4;
            let roomIndex = prop.RoomIndex ?? undefined;
            let roomIndices = roomIndex === undefined ? [] : [roomIndex];
            if (prop.OwnerSetupIndex != null && prop.OwnerPart != null) {
                const owner = propsBySetupIndex.get(prop.OwnerSetupIndex);
                const ownerMatrix = propMatrices.get(prop.OwnerSetupIndex);
                const attachment = owner === undefined ? null : modelAttachments.get(owner.ModelID)?.[prop.OwnerPart];
                if (owner === undefined || ownerMatrix === undefined || attachment == null)
                    continue;
                matrix = mat4.clone(ownerMatrix);
                mat4.multiply(matrix, matrix, attachment as mat4);
                mat4.rotateX(matrix, matrix, 0.36651915);
                const ownerScale = owner.Scale * (modelScale.get(owner.ModelID) ?? 1);
                const childScale = prop.Scale * (modelScale.get(prop.ModelID) ?? 1);
                const relativeScale = ownerScale === 0 ? 1 : childScale / ownerScale;
                mat4.scale(matrix, matrix, [relativeScale, relativeScale, relativeScale]);
                roomIndex = owner.RoomIndex ?? undefined;
                roomIndices = roomIndex === undefined ? [] : [roomIndex];
            } else if (prop.ChrNum != null && prop.AttachmentIndex != null) {
                const guard = guardsByChrNum.get(prop.ChrNum);
                const attachment = guard === undefined ? null : characterAttachments.get(guard.ModelID)?.[prop.AttachmentIndex];
                if (guard === undefined || attachment == null)
                    continue;
                roomIndex = guard.RoomIndex ?? undefined;
                roomIndices = roomIndex === undefined ? [] : [roomIndex];
                matrix = makePropMatrix(guard, modelScale.get(guard.ModelID) ?? 1,
                    modelBounds.get(guard.ModelID), placementBounds.get(guard.ModelID));
                mat4.multiply(matrix, matrix, attachment as mat4);
                // Attachment position inherits the body's world scale, but
                // the child model's basis does not: modelFindNodeMtx supplies
                // the hand transform and the equipped model then installs its
                // own independent scale. Preserve the translated hand point
                // while removing the body's scale from the three basis axes.
                for (let column = 0; column < 3; column++) {
                    const base = column * 4;
                    const length = Math.hypot(matrix[base], matrix[base + 1], matrix[base + 2]) || 1;
                    matrix[base] /= length; matrix[base + 1] /= length; matrix[base + 2] /= length;
                }
                const itemScale = prop.Scale * (canonicalModelScale.get(prop.ModelID) ?? 1) * archive.Scale;
                mat4.scale(matrix, matrix, [itemScale, itemScale, itemScale]);
            } else {
                matrix = makePropMatrix(prop, modelScale.get(prop.ModelID) ?? 1,
                    modelBounds.get(prop.ModelID), placementBounds.get(prop.ModelID));
                const bounds = modelBounds.get(prop.ModelID) ?? placementBounds.get(prop.ModelID);
                if (bounds !== undefined) {
                    let worldBounds = transformBounds(matrix, bounds);
                    if (prop.Type !== 9 && prop.Type !== 1 && prop.FloorY != null
                            && prop.Flags != null && (prop.Flags & 0x0E) === 0) {
                        let support = prop.FloorY;
                        for (const candidate of supportSurfaces)
                            if (candidate.roomIndex === roomIndex
                                    && prop.Position[0] >= candidate.bounds[0] && prop.Position[0] <= candidate.bounds[1]
                                    && prop.Position[2] >= candidate.bounds[4] && prop.Position[2] <= candidate.bounds[5]
                                    && candidate.bounds[3] <= worldBounds[3] && candidate.bounds[3] >= prop.FloorY)
                                support = Math.max(support, candidate.bounds[3]);
                        matrix[13] += support - worldBounds[2];
                        worldBounds = transformBounds(matrix, bounds);
                    }
                    supportSurfaces.push({ bounds: worldBounds, roomIndex });
                    if (instanceKind === 'prop') {
                        const intersectingRooms = archive.Rooms.filter((room) => {
                            const b = room.Bounds;
                            return b !== undefined && worldBounds[0] <= b[3] && worldBounds[1] >= b[0]
                                && worldBounds[2] <= b[4] && worldBounds[3] >= b[1]
                                && worldBounds[4] <= b[5] && worldBounds[5] >= b[2];
                        }).map((room) => room.Index);
                        if (intersectingRooms.length !== 0)
                            roomIndices = intersectingRooms;
                    }
                }
            }
            if (prop.SetupIndex != null)
                propMatrices.set(prop.SetupIndex, mat4.clone(matrix));
            for (const call of calls) {
                const instance = makeInstance(call);
                if (prop.ShadeColor != null && call.screenIndex === undefined) {
                    const shade = prop.ShadeColor;
                    instance.setModelShade(shade[0] / 255, shade[1] / 255,
                        shade[2] / 255, shade[3] / 255);
                }
                if (call.screenIndex !== undefined) {
                    const zMode = (prop.Flags2! & 0x00010000) !== 0 ? 0
                        : prop.Type === SetupType.MultiMonitor && call.screenIndex > 0
                            ? ((prop.Flags! & 0x30000000) !== 0 ? 8 : 1)
                            : ((prop.Flags! & 0x10000000) !== 0 ? 8 : 1);
                    const textureID = prop.MonitorTextureIDs?.[call.screenIndex];
                    const textureIndex = textureID === undefined ? undefined : indices.get(textureID);
                    if (textureIndex !== undefined)
                        instance.setTextureIndex(0, textureIndex);
                    const animationID = prop.MonitorAnimationIDs?.[call.screenIndex];
                    const root = animationID === undefined ? undefined : archive.MonitorAnimationRoots?.[animationID];
                    if (monitorCommands !== undefined && root !== undefined) {
                        const animator = new MonitorAnimator(monitorCommands, root, 0x9E3779B9 ^ (propIndex * 4 + call.screenIndex));
                        instance.enableVertexColorScale();
                        this.monitorBindings.push({ instance, animator, zMode });
                    }
                    instance.setRenderMode(zMode >= 2
                        ? RDP.RENDER_MODES.G_RM_AA_ZB_OPA_DECAL | RDP.RENDER_MODES.G_RM_AA_ZB_OPA_DECAL2
                        : zMode !== 0
                            ? RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF2
                            : RDP.RENDER_MODES.G_RM_AA_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_OPA_SURF2);
                    instance.setBackfaceCullingEnabled(true);
                }
                const glass = prop.TintDistance == null || prop.OpaqueDistance == null ? undefined : {
                    position: prop.Position,
                    near: prop.TintDistance * archive.Scale,
                    far: prop.OpaqueDistance * archive.Scale,
                    minimum: prop.MinimumOpacity ?? 0,
                };
                const planes = bspPlanes.get(call.modelID);
                const bsp = call.bspPath === undefined || planes === undefined ? undefined : { path: call.bspPath, planes };
                let callMatrix = matrix;
                if (prop.OwnerSetupIndex != null && call.screenMatrix !== undefined) {
                    const inverseScreenMatrix = mat4.invert(mat4.create(), call.screenMatrix as mat4);
                    if (inverseScreenMatrix !== null) {
                        callMatrix = mat4.clone(matrix);
                        mat4.multiply(callMatrix, callMatrix, inverseScreenMatrix);
                    }
                }
                // The flat model-104 "window" records in Dam are authored
                // floor shadows (uniform black, translucent texture 654).
                // The cart submits these decals before the model's translucent
                // stream so they cannot darken the chair geometry above them.
                const roomPhase = prop.Type === SetupType.Glass && prop.ModelID === 104 ? 'primary' : undefined;
                this.drawCallInstances.push({ instance, matrix: callMatrix, kind: instanceKind, roomIndex, roomIndices, roomPhase, glass, bsp });
            }
            propIndex++;
            if (prop.HeadModelID != null) {
                const headCalls = callsByModel.get(`${prop.HeadModelID}/`);
                const attachment = characterAttachment.get(prop.ModelID);
                if (headCalls !== undefined && attachment !== undefined) {
                    const headMatrix = mat4.clone(matrix);
                    mat4.multiply(headMatrix, headMatrix, attachment as mat4);
                    for (const call of headCalls) {
                        const instance = makeInstance(call);
                        if (prop.ShadeColor != null) {
                            const shade = prop.ShadeColor;
                            instance.setModelShade(shade[0] / 255, shade[1] / 255,
                                shade[2] / 255, shade[3] / 255);
                        }
                        this.drawCallInstances.push({ instance, matrix: headMatrix, kind: 'guard', roomIndex,
                            bsp: call.bspPath === undefined ? undefined : { path: call.bspPath, planes: bspPlanes.get(call.modelID) ?? [] } });
                    }
                }
            }
        }
    }

    public adjustCameraController(c: CameraController): void {
        c.setSceneMoveSpeedMult(0.1);
    }

    public getDefaultWorldMatrix(dst: mat4): void {
        mat4.copy(dst, this.defaultWorldMatrix);
    }

    public setRegressionOptions(options: Viewer.SceneRegressionOptions): void {
        this.regressionDisablePortalCulling = options.disablePortalCulling;
    }

    private buildVisibleRoomWindows(viewerInput: Viewer.ViewerRenderInput): Map<number, PortalWindow[]> {
        const rooms = this.archive.Rooms;
        const portals = this.archive.Portals ?? [];
        const allRooms = (): Map<number, PortalWindow[]> => new Map(rooms.map((room) => [room.Index, [[-1, -1, 1, 1]]]));
        if (rooms.length === 0)
            return new Map();
        if (!this.roomVisibilityEnabled || this.regressionDisablePortalCulling)
            return allRooms();
        // Some continuous outdoor backgrounds (Cradle and Cuba) genuinely
        // contain neither portals nor visibility commands beyond STOP. The
        // cartridge has no room relation to traverse in that case and submits
        // the complete background.
        const visibilityBytes = this.archive.GlobalVisibility;
        if (portals.length === 0 && (visibilityBytes === undefined || visibilityBytes.byteLength <= 8))
            return allRooms();
        const cx = viewerInput.camera.worldMatrix[12], cy = viewerInput.camera.worldMatrix[13], cz = viewerInput.camera.worldMatrix[14];
        let seed: RoomArchive | undefined;
        let bestVolume = Infinity;
        const initial = this.archive.InitialCamera;
        let authoredSeed: RoomArchive | undefined;
        const nearAuthoredStart = initial != null
            && Math.hypot(cx - initial.Position[0], cy - (initial.Position[1] + 160 * this.archive.Scale), cz - initial.Position[2]) < 400;
        if (initial?.RoomIndex != null && nearAuthoredStart)
            authoredSeed = rooms.find((room) => room.Index === initial.RoomIndex);
        const stanRooms = new Set(this.stanTiles.filter((tile) => pointInStanTile(cx, cz, tile)).map((tile) => tile.roomIndex));
        if (stanRooms.size === 0 && authoredSeed === undefined)
            return allRooms();
        for (const room of rooms) {
            const b = room.Bounds;
            const inside = b !== undefined && cx >= b[0] && cy >= b[1] && cz >= b[2]
                && cx <= b[3] && cy <= b[4] && cz <= b[5] && stanRooms.has(room.Index);
            if (inside) {
                const volume = Math.max(1, (b![3] - b![0]) * (b![4] - b![1]) * (b![5] - b![2]));
                if (volume >= bestVolume)
                    continue;
                bestVolume = volume;
                seed = room;
            }
        }
        if (seed === undefined)
            seed = authoredSeed;
        if (seed === undefined)
            return allRooms();
        type Bounds = PortalWindow;
        type ClipVertex = [number, number, number, number];
        const projectPortal = (portal: PortalArchive, parent: Bounds): Bounds | null => {
            let polygon: ClipVertex[] = portal.Points.map((point) => {
                const p = vec4.fromValues(point[0], point[1], point[2], 1);
                vec4.transformMat4(p, p, viewerInput.camera.clipFromWorldMatrix);
                return [p[0], p[1], p[2], p[3]];
            });
            // Clip against the camera plane before dividing. This mirrors the
            // cart helper's near-camera edge intersections and prevents a
            // behind-camera endpoint from exploding the portal rectangle.
            const clipped: ClipVertex[] = [];
            const epsilon = 0.001;
            for (let i = 0; i < polygon.length; i++) {
                const a = polygon[i], b = polygon[(i + 1) % polygon.length];
                const ai = a[3] >= epsilon, bi = b[3] >= epsilon;
                if (ai) clipped.push(a);
                if (ai !== bi) {
                    const t = (epsilon - a[3]) / (b[3] - a[3]);
                    clipped.push([
                        a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                        a[2] + (b[2] - a[2]) * t, epsilon,
                    ]);
                }
            }
            polygon = clipped;
            if (polygon.length < 3)
                return null;
            let minX = parent[0], minY = parent[1], maxX = parent[2], maxY = parent[3];
            let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
            for (const p of polygon) {
                px0 = Math.min(px0, p[0] / p[3]); py0 = Math.min(py0, p[1] / p[3]);
                px1 = Math.max(px1, p[0] / p[3]); py1 = Math.max(py1, p[1] / p[3]);
            }
            minX = Math.max(minX, px0, -1); minY = Math.max(minY, py0, -1);
            maxX = Math.min(maxX, px1, 1); maxY = Math.min(maxY, py1, 1);
            return maxX - minX > 0.0001 && maxY - minY > 0.0001 ? [minX, minY, maxX, maxY] : null;
        };
        // The spawn pad's STAN byte identifies its authored tile, while the
        // cart also resolves the camera against live room bounds. Keep both
        // roots: on overlapping boundaries (notably Aztec) either one alone
        // can omit the room actually surrounding the eye.
        const roots = new Set<number>([seed.Index]);
        if (authoredSeed !== undefined)
            roots.add(authoredSeed.Index);
        for (const portal of portals) {
            const adjacent = portal.Room1 === seed.Index ? portal.Room2 : portal.Room2 === seed.Index ? portal.Room1 : -1;
            if (adjacent < 0)
                continue;
            const b = rooms.find((room) => room.Index === adjacent)?.Bounds;
            if (b !== undefined && cx >= b[0] && cy >= b[1] && cz >= b[2]
                && cx <= b[3] && cy <= b[4] && cz <= b[5])
                roots.add(adjacent);
        }
        const visible = new Set<number>(roots);
        const windows = new Map<number, PortalWindow[]>();
        const addWindow = (room: number, bounds: PortalWindow): void => {
            let roomWindows = windows.get(room);
            if (roomWindows === undefined)
                windows.set(room, roomWindows = []);
            if (!roomWindows.some((other) => other.every((value, i) => Math.abs(value - bounds[i]) < 0.0001)))
                roomWindows.push([...bounds]);
        };
        for (const room of roots)
            addWindow(room, [-1, -1, 1, 1]);
        const queue: { room: number; bounds: Bounds; previous: number; depth: number }[] = [...roots].map((room) =>
            ({ room, bounds: [-1, -1, 1, 1], previous: -1, depth: 0 }));
        const visits = new Map<number, number>();
        for (let q = 0; q < queue.length && q < 500; q++) {
            const entry = queue[q];
            if (entry.depth >= 20)
                continue;
            for (let i = 0; i < portals.length; i++) {
                if (i === entry.previous)
                    continue;
                const portal = portals[i];
                const destination = portal.Room1 === entry.room ? portal.Room2 : portal.Room2 === entry.room ? portal.Room1 : -1;
                if (destination < 0)
                    continue;
                const bounds = projectPortal(portal, entry.bounds);
                if (bounds === null)
                    continue;
                visible.add(destination);
                addWindow(destination, bounds);
                const count = visits.get(destination) ?? 0;
                if (count < 4) {
                    visits.set(destination, count + 1);
                    queue.push({ room: destination, bounds, previous: i, depth: entry.depth + 1 });
                }
            }
        }
        const bytecode = this.archive.GlobalVisibility?.createDataView();
        if (bytecode !== undefined) {
            const stack: boolean[] = [];
            const executionStack: boolean[] = [];
            let execute = true;
            let authoredValid = true;
            let authoredBounds: Bounds = [-1, -1, 1, 1];
            const portalBounds = (address: number): Bounds | null => {
                const portal = portals.find((candidate) => candidate.Address === address)
                    ?? (address >= 0 && address < portals.length ? portals[address] : undefined);
                return portal === undefined ? null : projectPortal(portal, [-1, -1, 1, 1]);
            };
            const intersectBounds = (a: Bounds, b: Bounds): Bounds | null => {
                const result: Bounds = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
                return result[2] > result[0] && result[3] > result[1] ? result : null;
            };
            const argument = (offs: number, index: number): number | null => {
                const address = offs + 0x0C + index * 8;
                return address + 4 <= bytecode.byteLength ? bytecode.getInt32(address) : null;
            };
            for (let offs = 0, commands = 0; offs + 2 <= bytecode.byteLength && commands++ < 4096;) {
                const op = bytecode.getUint8(offs), records = bytecode.getUint8(offs + 1);
                if (op === 0 || records === 0)
                    break;
                if (op === 0x5A) {
                    executionStack.push(execute);
                    execute = execute && (stack.pop() ?? false);
                } else if (op === 0x5B) {
                    const parent = executionStack[executionStack.length - 1] ?? true;
                    execute = parent && !execute;
                } else if (op === 0x5C) {
                    execute = executionStack.pop() ?? true;
                } else if (execute) {
                    if (op === 1) stack.push(offs + 8 <= bytecode.byteLength && bytecode.getInt32(offs + 4) !== 0);
                    else if (op === 2) stack.pop();
                    else if (op === 3 || op === 4 || op === 6) {
                        const rhs = stack.pop() ?? false, lhs = stack.pop() ?? false;
                        stack.push(op === 3 ? lhs && rhs : op === 4 ? lhs || rhs : lhs !== rhs);
                    }
                    else if (op === 5) stack.push(!(stack.pop() ?? false));
                    else if (op === 0x14) {
                        const first = argument(offs, 0), last = argument(offs, 1);
                        stack.push(first !== null && last !== null && seed.Index >= first && seed.Index <= last);
                    } else if (op === 0x1E) {
                        authoredValid = true;
                        authoredBounds = [-1, -1, 1, 1];
                    } else if (op === 0x1F) {
                        const bounds = portalBounds(argument(offs, 0) ?? -1);
                        authoredValid = bounds !== null;
                        if (bounds !== null) authoredBounds = bounds;
                    } else if (op === 0x20) {
                        const room = argument(offs, 0);
                        if (authoredValid && room !== null) {
                            visible.add(room);
                            addWindow(room, authoredBounds);
                        }
                    } else if (op === 0x21) {
                        authoredValid = false;
                    } else if (op === 0x22) {
                        const bounds = portalBounds(argument(offs, 0) ?? -1);
                        if (bounds !== null) {
                            if (authoredValid) authoredBounds = [
                                Math.min(authoredBounds[0], bounds[0]), Math.min(authoredBounds[1], bounds[1]),
                                Math.max(authoredBounds[2], bounds[2]), Math.max(authoredBounds[3], bounds[3]),
                            ];
                            else authoredBounds = bounds;
                            authoredValid = true;
                        }
                    } else if (op === 0x23) {
                        const bounds = portalBounds(argument(offs, 0) ?? -1);
                        const intersection: Bounds | null = bounds === null || !authoredValid ? null : intersectBounds(authoredBounds, bounds);
                        authoredValid = intersection !== null;
                        if (intersection !== null) authoredBounds = intersection;
                    } else if (op === 0x24) {
                        const room = argument(offs, 0);
                        if (room !== null) {
                            visible.delete(room);
                            windows.delete(room);
                        }
                    } else if (op === 0x25) {
                        const first = argument(offs, 0), last = argument(offs, 1);
                        if (first !== null && last !== null)
                            for (let room = first; room <= last; room++) {
                                visible.delete(room);
                                windows.delete(room);
                            }
                    } else if (op === 0x26 || op === 0x27) {
                        // The cart calls these preload_room and preload_room_range.
                        // Every room is already resident in this viewer, so they
                        // intentionally have no effect on the visibility set.
                    }
                }
                offs += records * 8;
            }
        }
        // A few spawn pads sit exactly on a portal/room boundary. If neither
        // the spatial nor authored root can project even one outgoing portal,
        // hiding every other room produces an empty sky view. Conservatively
        // keep the complete BG until the camera moves out of the small spawn
        // neighborhood; this fails open without weakening normal traversal.
        if (nearAuthoredStart && visible.size <= roots.size)
            return allRooms();
        return windows;
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        if (this.portalsVisible)
            this.renderHelper.debugDraw.beginFrame(viewerInput.camera.projectionMatrix, viewerInput.camera.viewMatrix, viewerInput.backbufferWidth, viewerInput.backbufferHeight);
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        let offs = template.allocateUniformBuffer(F3DEX_Program.ub_SceneParams, 24);
        const mapped = template.mapUniformBufferF32(F3DEX_Program.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
        offs += fillVec4(mapped, offs, 1, 0, 0, 0);
        offs += fillVec4(mapped, offs, 0, 1, 0, 0);
        this.renderHelper.renderInstManager.setCurrentList(this.renderInstList);
        const roomWindows = this.buildVisibleRoomWindows(viewerInput);
        this.roomRenderInstLists = [];
        this.unscissoredRoomPrimary.reset();
        this.unscissoredRoomSecondary.reset();
        const roomLists = new Map<number, { primary: GfxRenderInstList; secondary: GfxRenderInstList; bounds: PortalWindow }[]>();
        for (const [room, windows] of roomWindows) {
            const lists = windows.map((bounds) => ({ primary: new GfxRenderInstList(), secondary: new GfxRenderInstList(), bounds }));
            roomLists.set(room, lists);
            this.roomRenderInstLists.push(...lists);
        }
        if (this.portalsVisible) {
            const activeColor = colorNewFromRGBA(0.15, 1, 0.25, 1);
            const frontierColor = colorNewFromRGBA(1, 0.75, 0.1, 1);
            const culledColor = colorNewFromRGBA(1, 0.15, 0.15, 1);
            for (const portal of this.archive.Portals ?? []) {
                const room1Visible = roomWindows.has(portal.Room1), room2Visible = roomWindows.has(portal.Room2);
                const color = room1Visible && room2Visible ? activeColor : room1Visible || room2Visible ? frontierColor : culledColor;
                for (let i = 0; i < portal.Points.length; i++)
                    this.renderHelper.debugDraw.drawLine(portal.Points[i] as [number, number, number], portal.Points[(i + 1) % portal.Points.length] as [number, number, number], color);
                const center = vec3.fromValues(
                    portal.Points.reduce((sum, point) => sum + point[0], 0) / portal.Points.length,
                    portal.Points.reduce((sum, point) => sum + point[1], 0) / portal.Points.length,
                    portal.Points.reduce((sum, point) => sum + point[2], 0) / portal.Points.length,
                );
                this.renderHelper.debugDraw.drawWorldText(`${portal.Room1} <-> ${portal.Room2}`, center, color, { fontSize: 10 });
            }
        }
        for (const { instance, animator, zMode } of this.monitorBindings) {
            animator.update(viewerInput.time);
            const textureIndex = this.textureIndices.get(animator.textureID);
            if (textureIndex !== undefined)
                instance.setTextureIndex(0, textureIndex);
            instance.setTextureAnimation(animator.displayXmid, animator.displayYmid, animator.displayXscale, animator.displayYscale, animator.rotation);
            instance.setVertexColorScale(animator.displayRed, animator.displayGreen, animator.displayBlue, animator.displayAlpha);
            instance.setRenderMode(animator.displayAlpha < 1
                ? zMode >= 2
                    ? RDP.RENDER_MODES.G_RM_AA_ZB_XLU_DECAL | RDP.RENDER_MODES.G_RM_AA_ZB_XLU_DECAL2
                    : zMode !== 0
                        ? RDP.RENDER_MODES.G_RM_AA_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_AA_ZB_XLU_SURF2
                        : RDP.RENDER_MODES.G_RM_AA_XLU_SURF | RDP.RENDER_MODES.G_RM_AA_XLU_SURF2
                : zMode >= 2
                    ? RDP.RENDER_MODES.G_RM_AA_ZB_OPA_DECAL | RDP.RENDER_MODES.G_RM_AA_ZB_OPA_DECAL2
                    : zMode !== 0
                        ? RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF2
                        : RDP.RENDER_MODES.G_RM_AA_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_OPA_SURF2);
            instance.setBackfaceCullingEnabled(true);
        }
        for (const { instance, matrix, kind, environmentKind, drawCall, roomIndex, roomIndices, roomPhase, glass, bsp } of this.drawCallInstances) {
            const kindVisible = kind === 'prop' ? this.propsVisible : kind === 'guard' ? this.guardsVisible : true;
            if (roomIndex !== undefined) {
                const bounds = this.roomBounds.get(roomIndex);
                instance.visible = kindVisible && (roomIndices ?? [roomIndex]).some((room) => roomWindows.has(room))
                    && (bounds === undefined || viewerInput.camera.frustum.contains(bounds));
            } else
                instance.visible = kindVisible;
            if (environmentKind !== undefined) {
                const cameraX = viewerInput.camera.worldMatrix[12];
                const cameraY = viewerInput.camera.worldMatrix[13];
                const cameraZ = viewerInput.camera.worldMatrix[14];
                mat4.identity(matrix);
                matrix[12] = cameraX;
                matrix[14] = cameraZ;
                const effect = environmentKind === -2 ? this.environment?.cloud : this.environment?.water;
                // The field lives in the water tail of CurrentEnvironment, but
                // sub_GAME_7F093880 is shared by the cloud and water halves of
                // skyRender. It therefore offsets either environment plane.
                const waterConcavity = this.environment?.concavity ?? 0;
                if (waterConcavity !== 0) {
                    // skyRender constructs water intersections from rays whose
                    // screen Y includes WaterConcavity, then subtracts the same
                    // value from the projected quarter-pixel Y. Thus the water
                    // remains a flat world plane, but its projected vertices
                    // are shifted upward by concavity pixels while retaining
                    // the texture coordinates of the shifted rays. Express the
                    // clip-space Y offset as a camera-space Y/Z shear:
                    //   clipY' = clipY + (2C / 240) clipW.
                    // Conjugating by the camera matrices lets the ordinary
                    // model-view shader reproduce that original RDP polygon.
                    mat4.copy(environmentViewScratch, viewerInput.camera.viewMatrix);
                    mat4.identity(environmentShearScratch);
                    environmentShearScratch[9] = -(2 * waterConcavity / 240) / viewerInput.camera.projectionMatrix[5];
                    mat4.multiply(environmentWorldScratch, viewerInput.camera.worldMatrix, environmentShearScratch);
                    mat4.multiply(environmentWorldScratch, environmentWorldScratch, environmentViewScratch);
                    mat4.multiply(matrix, environmentWorldScratch, matrix);
                }
                if (effect !== undefined && drawCall !== undefined) {
                    updateEnvironmentPolygon(drawCall, viewerInput, effect.height * this.archive.Scale,
                        effect.color, this.environment!.sky, environmentKind === -2, waterConcavity);
                    if (environmentKind === -3)
                        drawCall.DP_PrimColor.a = (128 + 127 * Math.sin(viewerInput.time * 60 / 1000 * 0.04)) / 255;
                    drawCall.renderData!.updateBuffers();
                }
                const worldUVScale = environmentKind === -2 ? 0.1 : 1;
                const effectTextureSize = environmentKind === -3 ? 32 : 64;
                instance.setTextureOffset(cameraX * worldUVScale / (32 * effectTextureSize), cameraZ * worldUVScale / (32 * effectTextureSize));
            }
            if (glass !== undefined) {
                const cameraX = viewerInput.camera.worldMatrix[12], cameraY = viewerInput.camera.worldMatrix[13], cameraZ = viewerInput.camera.worldMatrix[14];
                const distance = Math.hypot(glass.position[0] - cameraX, glass.position[1] - cameraY, glass.position[2] - cameraZ);
                instance.envAlpha = distance > glass.far ? 1 : distance < glass.near ? glass.minimum
                    : glass.minimum + (distance - glass.near) * (1 - glass.minimum) / Math.max(0.000001, glass.far - glass.near);
            }
            if (bsp !== undefined) {
                let bias = 0;
                for (let i = 0; i < bsp.path.length && i < 8; i++) {
                    const branch = bsp.path[i], plane = bsp.planes[branch.Index];
                    if (plane === undefined)
                        continue;
                    mat4.multiply(environmentWorldScratch, viewerInput.camera.viewMatrix, matrix);
                    mat4.multiply(environmentViewScratch, environmentWorldScratch, plane.Matrix as mat4);
                    const p = plane.Point, n = plane.Vector, m = environmentViewScratch;
                    const px = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
                    const py = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
                    const pz = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
                    let nx: number, ny: number, nz: number;
                    if (plane.Mode === 1) { nx = m[0] * n[0]; ny = m[1] * n[0]; nz = m[2] * n[0]; }
                    else if (plane.Mode === 2) { nx = m[4] * n[1]; ny = m[5] * n[1]; nz = m[6] * n[1]; }
                    else if (plane.Mode === 3) { nx = m[8] * n[2]; ny = m[9] * n[2]; nz = m[10] * n[2]; }
                    else {
                        nx = m[0] * n[0] + m[4] * n[1] + m[8] * n[2];
                        ny = m[1] * n[0] + m[5] * n[1] + m[9] * n[2];
                        nz = m[2] * n[0] + m[6] * n[1] + m[10] * n[2];
                    }
                    const visible = nx * px + ny * py + nz * pz < 0;
                    const firstSide = visible ? 0 : 1;
                    if (branch.Side !== firstSide)
                        bias |= 1 << (7 - i);
                }
                instance.setSortBias(bias);
            }
            if (instance.visible && roomIndex !== undefined) {
                // A setup prop can overlap several room bounds, but it is still
                // one object. Submitting it to every visible room is harmless
                // for opaque geometry and visibly wrong for translucent model
                // streams (the swivel-chair cutouts accumulate into slabs).
                // Prefer the authored room, falling back to another intersected
                // room only when portal traversal has culled the authored one.
                const memberRooms = roomIndices ?? [roomIndex];
                if (memberRooms.length > 1) {
                    // A prop spanning multiple rooms must not inherit any one
                    // room's portal scissor: that clips the object at the
                    // window boundary. Visibility was already accepted above,
                    // so submit it once to the unscissored scene list.
                    const translucentModel = roomPhase === undefined && instance.isTranslucent();
                    this.renderHelper.renderInstManager.setCurrentList(roomPhase === 'secondary' || translucentModel
                        ? this.unscissoredRoomSecondary : this.unscissoredRoomPrimary);
                    instance.prepareToRender(device, this.renderHelper.renderInstManager, viewerInput, matrix);
                    this.renderHelper.renderInstManager.setCurrentList(this.renderInstList);
                    continue;
                }
                const activeRoom = roomLists.has(roomIndex) ? roomIndex
                    : memberRooms.find((room) => roomLists.has(room));
                for (const lists of activeRoom === undefined ? [] : roomLists.get(activeRoom) ?? []) {
                    const list = roomPhase === 'secondary' ? lists.secondary : lists.primary;
                    this.renderHelper.renderInstManager.setCurrentList(list);
                    instance.prepareToRender(device, this.renderHelper.renderInstManager, viewerInput, matrix);
                }
                this.renderHelper.renderInstManager.setCurrentList(this.renderInstList);
            } else {
                this.renderHelper.renderInstManager.setCurrentList(this.renderInstList);
                instance.prepareToRender(device, this.renderHelper.renderInstManager, viewerInput, matrix);
            }
        }
        this.renderHelper.renderInstManager.popTemplate();
        this.renderHelper.prepareToRender();
    }

    public createPanels(): UI.Panel[] {
        const renderHacksPanel = new UI.Panel();
        renderHacksPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        renderHacksPanel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');

        const enableFog = new UI.Checkbox('Enable Fog', true);
        enableFog.onchanged = () => {
            const fogRange = this.environment === undefined ? null : getFogRange(this.environment, this.archive.VisibilityScale);
            for (const instance of this.fogInstances) {
                if (enableFog.checked && fogRange !== null)
                    instance.setFog(fogRange[0] * this.archive.Scale, fogRange[1] * this.archive.Scale, this.environment!.sky);
                else
                    instance.setFog(0, 0, null);
            }
        };
        renderHacksPanel.contents.appendChild(enableFog.elem);

        const enableRoomVisibility = new UI.Checkbox('Enable Room/Visibility', true);
        enableRoomVisibility.onchanged = () => this.roomVisibilityEnabled = enableRoomVisibility.checked;
        renderHacksPanel.contents.appendChild(enableRoomVisibility.elem);

        const showProps = new UI.Checkbox('Show Props', true);
        showProps.onchanged = () => this.propsVisible = showProps.checked;
        renderHacksPanel.contents.appendChild(showProps.elem);

        const showGuards = new UI.Checkbox('Show Guards', true);
        showGuards.onchanged = () => this.guardsVisible = showGuards.checked;
        renderHacksPanel.contents.appendChild(showGuards.elem);

        const visualizePortals = new UI.Checkbox('Visualize Portals', false);
        visualizePortals.onchanged = () => this.portalsVisible = visualizePortals.checked;
        renderHacksPanel.contents.appendChild(visualizePortals.elem);

        return [renderHacksPanel];
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        const clearDescriptor = this.environment === undefined ? standardFullClearRenderPassDescriptor : makeAttachmentClearDescriptor(this.environment.sky);
        const color = builder.createRenderTargetID(makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, clearDescriptor), 'Main Color');
        const depth = builder.createRenderTargetID(makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor), 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('GoldenEye Level');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, color);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, depth);
            pass.exec((passRenderer) => {
                passRenderer.setScissor(0, 0, viewerInput.backbufferWidth, viewerInput.backbufferHeight);
                this.renderInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                const drawRoomList = (list: GfxRenderInstList, bounds: PortalWindow): void => {
                    const x0 = Math.max(0, Math.floor((bounds[0] + 1) * 0.5 * viewerInput.backbufferWidth));
                    const y0 = Math.max(0, Math.floor((bounds[1] + 1) * 0.5 * viewerInput.backbufferHeight));
                    const x1 = Math.min(viewerInput.backbufferWidth, Math.ceil((bounds[2] + 1) * 0.5 * viewerInput.backbufferWidth));
                    const y1 = Math.min(viewerInput.backbufferHeight, Math.ceil((bounds[3] + 1) * 0.5 * viewerInput.backbufferHeight));
                    if (x1 > x0 && y1 > y0) {
                        passRenderer.setScissor(x0, y0, x1 - x0, y1 - y0);
                        list.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                    }
                };
                // bgRenderVisibleRoomsAndProps walks primary room geometry in
                // increasing traversal depth, then walks secondary geometry
                // in decreasing depth. Both loops install the room's clipped
                // screen rectangle immediately before submitting its DL.
                for (const { primary, bounds } of this.roomRenderInstLists)
                    drawRoomList(primary, bounds);
                passRenderer.setScissor(0, 0, viewerInput.backbufferWidth, viewerInput.backbufferHeight);
                this.unscissoredRoomPrimary.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                this.unscissoredRoomSecondary.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
                for (let i = this.roomRenderInstLists.length - 1; i >= 0; i--) {
                    const { secondary, bounds } = this.roomRenderInstLists[i];
                    drawRoomList(secondary, bounds);
                }
                passRenderer.setScissor(0, 0, viewerInput.backbufferWidth, viewerInput.backbufferHeight);
            });
        });
        if (this.portalsVisible)
            this.renderHelper.debugDraw.pushPasses(builder, color, depth);
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, color);
        builder.resolveRenderTargetToExternalTexture(color, viewerInput.onscreenTexture);
        this.prepareToRender(device, viewerInput);
        builder.execute();
        this.renderInstList.reset();
        for (const { primary, secondary } of this.roomRenderInstLists) {
            primary.reset();
            secondary.reset();
        }
    }

    public destroy(device: GfxDevice): void {
        for (const drawCall of this.drawCalls)
            drawCall.destroy(device);
        this.renderHelper.destroy();
    }
}

const pathBase = 'GoldenEye007';

class SceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string) {}

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const compressed = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.crg1`);
        const archiveData = ArrayBufferSlice.fromView(decompress(compressed.createTypedArray(Uint8Array)));
        const archive = BYML.parse<LevelArchive>(archiveData, BYML.FileType.CRG1);
        return new GoldenEyeRenderer(device, archive);
    }
}

const sceneDescs: (string | SceneDesc)[] = [
    'Multiplayer',
    new SceneDesc('mp-temple', 'Temple'),
    new SceneDesc('mp-complex', 'Complex'),
    new SceneDesc('mp-caves', 'Caves'),
    new SceneDesc('mp-library', 'Library'),
    new SceneDesc('mp-basement', 'Basement'),
    new SceneDesc('mp-stack', 'Stack'),
    new SceneDesc('mp-facility', 'Facility'),
    new SceneDesc('mp-bunker', 'Bunker'),
    new SceneDesc('mp-archives', 'Archives'),
    new SceneDesc('mp-caverns', 'Caverns'),
    new SceneDesc('mp-egyptian', 'Egyptian'),

    'Single Player',
    new SceneDesc('dam', 'Dam'),
    new SceneDesc('facility', 'Facility'),
    new SceneDesc('runway', 'Runway'),
    new SceneDesc('surface1', 'Surface I'),
    new SceneDesc('bunker1', 'Bunker I'),
    new SceneDesc('silo', 'Silo'),
    new SceneDesc('frigate', 'Frigate'),
    new SceneDesc('surface2', 'Surface II'),
    new SceneDesc('bunker2', 'Bunker II'),
    new SceneDesc('statue', 'Statue'),
    new SceneDesc('archives', 'Archives'),
    new SceneDesc('streets', 'Streets'),
    new SceneDesc('depot', 'Depot'),
    new SceneDesc('train', 'Train'),
    new SceneDesc('jungle', 'Jungle'),
    new SceneDesc('control', 'Control'),
    new SceneDesc('caverns', 'Caverns'),
    new SceneDesc('cradle', 'Cradle'),
    new SceneDesc('aztec', 'Aztec'),
    new SceneDesc('egypt', 'Egyptian'),

    'Bonus / Unused',
    new SceneDesc('citadel', 'Citadel'),
    new SceneDesc('cuba', 'Cuba'),
];

export const sceneGroup: Viewer.SceneGroup = {
    id: 'ge007',
    name: 'GoldenEye 007',
    altName: 'GoldenEye',
    sceneDescs,
};
