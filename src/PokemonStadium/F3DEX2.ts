
import * as F3DEX from '../BanjoKazooie/f3dex.js';
import * as RDP from '../Common/N64/RDP.js';

import { nArray, assert, assertExists, hexzero } from "../util.js";
import { getSizBitsPerPixel, ImageFormat } from "../Common/N64/Image.js";
import { vec4 } from 'gl-matrix';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { GfxCullMode, GfxMegaStateDescriptor } from '../gfx/platform/GfxPlatform.js';

// Interpreter for N64 F3DEX2 microcode.

export interface DataMap {
    getView(address: number): DataView;
    getRange(address: number): { data: ArrayBufferSlice; start: number };
    textureCacheNamespace?: number;
}

export enum RSP_Geometry {
    G_ZBUFFER            = 1 << 0,
    G_SHADE              = 1 << 2,
    G_CULL_FRONT         = 1 << 9,
    G_CULL_BACK          = 1 << 10,
    G_FOG                = 1 << 16,
    G_LIGHTING           = 1 << 17,
    G_TEXTURE_GEN        = 1 << 18,
    G_TEXTURE_GEN_LINEAR = 1 << 19,
    G_SHADING_SMOOTH     = 1 << 21,
    G_CLIPPING           = 1 << 23,
}

export function translateBlendMode(geoMode: number, renderMode: number): Partial<GfxMegaStateDescriptor> {
    const out = RDP.translateRenderMode(renderMode);
    out.cullMode = translateCullMode(geoMode);

    return out;
}

export function translateCullMode(geoMode: number): GfxCullMode {
    const cullBack = !!(geoMode & RSP_Geometry.G_CULL_BACK);
    const cullFront = !!(geoMode & RSP_Geometry.G_CULL_FRONT);
    if (cullBack && cullFront) {
        throw new Error('F3DEX2 geometry mode enables both front- and back-face culling');
    } else if (cullBack) {
        return GfxCullMode.Back;
    } else if (cullFront) {
        return GfxCullMode.Front;
    } else {
        return GfxCullMode.None;
    }
}

export class DrawCall extends F3DEX.DrawCall {
    public DP_PrimColor = vec4.fromValues(1, 1, 1, 1);
    public DP_EnvColor = vec4.fromValues(1, 1, 1, 1);
    public DP_PrimLOD = 0;
    public materialIndex = -1;

    public stadiumLayer = -1;
    public stadiumTextureVariants: number[][] = [];
    public stadiumMaterialAnimationChannel = -1;
    public stadiumLightColors: number[][] = [];
    public stadiumLightDirections: number[][] = [];
    public stadiumLightAnimations: Array<{ index: number; period: number; times: number[]; colors: number[][] }> = [];
    public stadiumAmbientColor: number[] = [0, 0, 0];
    public stadiumBillboard = 0;
    public stadiumDualTextureScroll = false;
    public stadiumTextureScrollSpeeds: readonly (readonly [number, number])[] = [];
    public stadiumFreeRunningTextureAnimation = false;
    public stadiumGsSelectedTextureAnimation = false;
    public stadiumGsMaterialVariantTextureIndices: number[] = [];
    /** TEXEL0 is supplied by the live 32x32 current-Pokemon capture target. */
    public stadiumGsCurrentPokemonTexture = false;
    public stadiumGsParticleVertexAlphaScale = false;
    /** Slot in Stadium 2's ten-record Pokemon model-decoration particle pool. */
    public stadiumGsModelParticleIndex = -1;
    public stadiumGsModelParticleGroupIndex = -1;
    public stadiumIA8Flame = false;
    public stadiumParticlePrimitiveEnvironment = false;
    public stadiumDualTextureParticleColor = false;
    public stadiumLeerEyeMask = false;
    public stadiumModelParticleColorMode: 'all' | 'alpha' | 'none' = 'all';
    public stadiumTextureTiles: RDP.TileState[] = [];
}

// same logic, just with the new type
export class RSPOutput extends F3DEX.RSPOutput {
    public override drawCalls: DrawCall[] = [];

    public override currentDrawCall = new DrawCall();

    public override newDrawCall(firstIndex: number): DrawCall {
        this.currentDrawCall = new DrawCall();
        this.currentDrawCall.firstIndex = firstIndex;
        this.drawCalls.push(this.currentDrawCall);
        return this.currentDrawCall;
    }
}

function addSegment(dataMap: DataMap, segments: ArrayBufferSlice[], addr: number): number {
    const seg = (addr >>> 24) & 0x7F;
    const range = dataMap.getRange(addr);
    segments[seg] = range.data;
    if (seg === 0)
        return addr - range.start;
    // Relocated fragment pointers use KSEG-style 0x8F addresses while the
    // segment buffer table is indexed by the low seven-bit segment number.
    return (seg << 24) | (addr - range.start);
}

export class RSPState {
    private output = new RSPOutput();

    private stateChanged: boolean = false;
    private minorChange: boolean = false;
    private vertexCache = nArray(64, () => new F3DEX.StagingVertex());

    private SP_GeometryMode: number = 0;
    private SP_TextureState = new F3DEX.TextureState();

    private DP_OtherModeL: number = 0;
    private DP_OtherModeH: number;
    private DP_CombineL: number = 0;
    private DP_CombineH: number = 0;
    private DP_TextureImageState = new F3DEX.TextureImageState();
    private DP_TileState = nArray(8, () => new RDP.TileState());
    private DP_TMemTracker = new Map<number, number>();
    private DP_TMemLoadedByTile = new Set<number>();
    private textureDescriptors = new Map<number, { fmt: number; siz: number; width: number; height: number }>();

    private DP_PrimColor = vec4.create();
    private DP_EnvColor = vec4.create();
    private DP_PrimLOD = 0;

    private SP_MatrixIndex = 0;
    private stadiumLayer = -1;
    private stadiumTextureVariants: number[][] = [];
    private stadiumMaterialAnimationChannel = -1;
    private stadiumLightColors: number[][] = [];
    private stadiumLightDirections: number[][] = [];
    private stadiumLightAnimations: Array<{ index: number; period: number; times: number[]; colors: number[][] }> = [];
    private stadiumAmbientColor: number[] = [0, 0, 0];
    private stadiumBillboard = 0;
    private stadiumDualTextureScroll = false;
    private stadiumTextureScrollSpeeds: readonly (readonly [number, number])[] = [];
    private stadiumFreeRunningTextureAnimation = false;
    private stadiumGsSelectedTextureAnimation = false;
    private stadiumGsMaterialVariantTextureIndices: number[] = [];
    private stadiumGsCurrentPokemonTexture = false;
    private stadiumGsParticleVertexAlphaScale = false;
    private stadiumGsModelParticleIndex = -1;
    private stadiumGsModelParticleGroupIndex = -1;
    private stadiumIA8Flame = false;
    private stadiumParticlePrimitiveEnvironment = false;
    private stadiumDualTextureParticleColor = false;
    private stadiumLeerEyeMask = false;
    private stadiumModelParticleColorMode: 'all' | 'alpha' | 'none' = 'all';
    private renderQueueStates = new Map<number, () => void>();
    private pendingMaterialState: (() => void) | null = null;
    private pendingMaterialQueues = new Set<number>();
    public DP_Half1 = 0;

    public materialIndex = -1;

    public pushDisplayListState(): () => void {
        const restoreDisplayListState = this.captureDisplayListState(true);
        // Graph callbacks write temporary state into the active render queue.
        // Saving only the immediate RSP/RDP registers lets that state escape
        // when a later sibling resumes the same queue (Grimer's puddle frames
        // then became its face texture). Scope the queue snapshots along with
        // the callback subtree, matching the graph traversal stack.
        const renderQueueStates = new Map(this.renderQueueStates);
        return () => {
            this.renderQueueStates = new Map(renderQueueStates);
            restoreDisplayListState();
        };
    }

    private captureDisplayListState(includePendingMaterial: boolean): () => void {
        const textureState = new F3DEX.TextureState(); textureState.copy(this.SP_TextureState);
        const geometryMode = this.SP_GeometryMode;
        const otherModeL = this.DP_OtherModeL, otherModeH = this.DP_OtherModeH;
        const textureImage = new F3DEX.TextureImageState();
        textureImage.set(this.DP_TextureImageState.fmt, this.DP_TextureImageState.siz, this.DP_TextureImageState.w, this.DP_TextureImageState.addr);
        const tiles = this.DP_TileState.map((tile) => { const copy = new RDP.TileState(); copy.copy(tile); return copy; });
        const tmemTracker = new Map(this.DP_TMemTracker), loadedByTile = new Set(this.DP_TMemLoadedByTile);
        const combineL = this.DP_CombineL, combineH = this.DP_CombineH;
        const primColor = vec4.clone(this.DP_PrimColor), envColor = vec4.clone(this.DP_EnvColor), primLOD = this.DP_PrimLOD;
        const variants = this.stadiumTextureVariants, channel = this.stadiumMaterialAnimationChannel;
        const dualTextureScroll = this.stadiumDualTextureScroll;
        const textureScrollSpeeds = this.stadiumTextureScrollSpeeds;
        const freeRunningTextureAnimation = this.stadiumFreeRunningTextureAnimation;
        const ia8Flame = this.stadiumIA8Flame;
        const leerEyeMask = this.stadiumLeerEyeMask;
        const modelParticleColorMode = this.stadiumModelParticleColorMode;
        const particleVertexAlphaScale = this.stadiumGsParticleVertexAlphaScale;
        const modelParticleIndex = this.stadiumGsModelParticleIndex;
        const modelParticleGroupIndex = this.stadiumGsModelParticleGroupIndex;
        const currentPokemonTexture = this.stadiumGsCurrentPokemonTexture;
        const pendingMaterialState = this.pendingMaterialState;
        const pendingMaterialQueues = new Set(this.pendingMaterialQueues);
        return () => {
            this.SP_TextureState.copy(textureState);
            this.SP_GeometryMode = geometryMode;
            this.DP_OtherModeL = otherModeL; this.DP_OtherModeH = otherModeH;
            this.DP_TextureImageState.set(textureImage.fmt, textureImage.siz, textureImage.w, textureImage.addr);
            for (let i = 0; i < tiles.length; i++) this.DP_TileState[i].copy(tiles[i]);
            this.DP_TMemTracker = new Map(tmemTracker); this.DP_TMemLoadedByTile = new Set(loadedByTile);
            this.DP_CombineL = combineL; this.DP_CombineH = combineH;
            vec4.copy(this.DP_PrimColor, primColor); vec4.copy(this.DP_EnvColor, envColor); this.DP_PrimLOD = primLOD;
            this.stadiumTextureVariants = variants; this.stadiumMaterialAnimationChannel = channel;
            this.stadiumDualTextureScroll = dualTextureScroll;
            this.stadiumTextureScrollSpeeds = textureScrollSpeeds;
            this.stadiumFreeRunningTextureAnimation = freeRunningTextureAnimation;
            this.stadiumIA8Flame = ia8Flame;
            this.stadiumLeerEyeMask = leerEyeMask;
            this.stadiumModelParticleColorMode = modelParticleColorMode;
            this.stadiumGsParticleVertexAlphaScale = particleVertexAlphaScale;
            this.stadiumGsModelParticleIndex = modelParticleIndex;
            this.stadiumGsModelParticleGroupIndex = modelParticleGroupIndex;
            this.stadiumGsCurrentPokemonTexture = currentPokemonTexture;
            if (includePendingMaterial) {
                this.pendingMaterialState = pendingMaterialState;
                this.pendingMaterialQueues = new Set(pendingMaterialQueues);
            }
            this.stateChanged = true;
        };
    }

    /** Capture the material selected by GraphNode_RenderMaterial. */
    public commitMaterialState(): void {
        // Capturing as a restoration closure keeps TileState / TextureState
        // cloning in one place. The closure is immutable and can be replayed
        // when geometry is submitted to any render queue.
        this.pendingMaterialState = this.captureDisplayListState(false);
        this.pendingMaterialQueues.clear();
    }

    /**
     * Select a Stadium render queue and apply the graph's pending material.
     * The returned function saves mutations made by the geometry display list
     * back into that queue, then restores graph-traversal state.
     */
    public beginRenderQueue(queue: number, billboard: number): () => void {
        const restoreGraphState = this.captureDisplayListState(false);
        this.renderQueueStates.get(queue)?.();
        if (this.pendingMaterialState !== null && !this.pendingMaterialQueues.has(queue)) {
            this.pendingMaterialState();
            this.pendingMaterialQueues.add(queue);
        }
        this.stadiumLayer = queue;
        this.stadiumBillboard = billboard;
        this.stateChanged = true;
        return () => {
            this.renderQueueStates.set(queue, this.captureDisplayListState(false));
            restoreGraphState();
        };
    }

    constructor(public sharedOutput: F3DEX.RSPSharedOutput, public dataMap: DataMap, initialOtherModeH: number = 0) {
        this.DP_OtherModeH = initialOtherModeH;
    }

    public setMatrixIndex(index: number): void {
        this.SP_MatrixIndex = index;
    }

    public setTextureVariants(variants: number[][]): void {
        this.stadiumTextureVariants = variants;
    }

    public setMaterialAnimationChannel(channel: number): void {
        this.stadiumMaterialAnimationChannel = channel;
    }

    public clearGeneratedTexturePass(): void {
        this.stadiumDualTextureScroll = false;
        this.stadiumTextureScrollSpeeds = [];
        this.stadiumFreeRunningTextureAnimation = false;
        this.stadiumIA8Flame = false;
    }

    /** scroll_particle_render_tile / scroll_particle_texture_tile_one: animate the render-tile origins. */
    public setTextureScrollSpeeds(speeds: readonly (readonly [number, number])[]): void {
        this.stadiumTextureScrollSpeeds = speeds;
        this.stateChanged = true;
    }

    public setLights(colors: number[][], directions: number[][], ambient: number[]): void {
        this.stadiumLightColors = colors;
        this.stadiumLightDirections = directions;
        this.stadiumAmbientColor = ambient;
    }

    public setLightAnimation(index: number, period: number, times: number[], colors: number[][]): void {
        this.stadiumLightAnimations = this.stadiumLightAnimations.filter((animation) => animation.index !== index);
        this.stadiumLightAnimations.push({ index, period, times: [...times], colors: colors.map((color) => [...color]) });
        this.stateChanged = true;
    }

    public registerTextureDescriptor(address: number, fmt: number, siz: number, width: number, height: number): void {
        this.textureDescriptors.set(address, { fmt, siz, width, height });
    }

    // fragment31 build_grimer_muk_body_display_list: Grimer/Muk's animated two-layer body pass.
    public runDualTextureScrollPass(texture0: number, texture1: number, scroll: number, legacyFrameAnimation: boolean = true): void {
        this.stadiumDualTextureScroll = legacyFrameAnimation;
        this.gDPSetCombine(0x00262A04, 0x1F1893FF);
        this.gSPSetEnvColor(0xFF, 0xFF, 0xFF, 0x64);

        const loadLayer = (address: number, tmem: number, tile: number): void => {
            this.gDPSetTextureImage(ImageFormat.G_IM_FMT_RGBA, 2, 32, address);
            this.gDPSetTile(ImageFormat.G_IM_FMT_RGBA, 2, 0, tmem, 7, 0, 2, 0, 0, 2, 0, 0);
            this.gDPLoadTile(7, 0, 0, 0x7C, 0x7C);
            this.gDPSetTile(ImageFormat.G_IM_FMT_RGBA, 2, 8, tmem, tile, 0, 1, 5, 0, 1, 5, 0);
            this.gDPSetTileSize(tile, 0, 0, 0x7C, 0x7C);
        };
        loadLayer(texture0, 0x000, 0);
        loadLayer(texture1, 0x100, 1);

        const s0 = scroll >> 4;
        const t0 = 0x4000 - (scroll >> 4);
        const t1 = 0x4000 - (scroll >> 3);
        this.gDPSetTileSize(0, s0 & 0x0FFF, t0 & 0x0FFF, (s0 + 0x1F) & 0x0FFF, (t0 + 0x1F) & 0x0FFF);
        this.gDPSetTileSize(1, t0 & 0x0FFF, t1 & 0x0FFF, t0 & 0x0FFF, (t1 + 0x1F) & 0x0FFF);
    }

    // fragment31 build_grimer_muk_puddle_texture_display_list: load one frame of Grimer/Muk's puddle.
    public loadPuddleTextureFrame(address: number): void {
        this.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
        this.gDPSetTextureImage(ImageFormat.G_IM_FMT_RGBA, 2, 32, address);
        this.gDPSetTile(ImageFormat.G_IM_FMT_RGBA, 2, 0, 0, 7, 0, 2, 0, 0, 2, 0, 0);
        this.gDPLoadBlock(7, 0, 0, 0x3FF, 0x100);
        this.gDPSetTile(ImageFormat.G_IM_FMT_RGBA, 2, 8, 0, 0, 0, 1, 5, 0, 1, 5, 0);
        this.gDPSetTileSize(0, 0, 0, 0x7C, 0x7C);
    }

    /** fragment31's animated 32x64 IA8 material callback. */
    public loadAnimatedIA8TextureFrame(address: number): void {
        this.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
        this.gDPSetTextureImage(ImageFormat.G_IM_FMT_IA, 1, 32, address);
        this.gDPSetTile(ImageFormat.G_IM_FMT_IA, 1, 0, 0, 7, 0, 2, 0, 0, 2, 0, 0);
        this.gDPLoadBlock(7, 0, 0, 0x7FF, 0x200);
        this.gDPSetTile(ImageFormat.G_IM_FMT_IA, 1, 4, 0, 0, 0, 2, 0, 0, 2, 0, 0);
        this.gDPSetTileSize(0, 0, 0, 0x7C, 0xFC);
    }

    /** Stadium 2's generated-segment callback: IA16, 1024 texels, 32-pixel line stride. */
    public loadGeneratedSegmentIA16TextureFrame(address: number): void {
        this.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
        this.gDPSetTextureImage(ImageFormat.G_IM_FMT_IA, 2, 1, address);
        this.gDPSetTile(ImageFormat.G_IM_FMT_IA, 2, 0, 0, 7, 0, 2, 0, 0, 2, 0, 0);
        this.gDPLoadBlock(7, 0, 0, 0x3FF, 0x200);
        this.gDPSetTile(ImageFormat.G_IM_FMT_IA, 2, 8, 0, 0, 0, 2, 0, 0, 2, 0, 0);
        this.gDPSetTileSize(0, 0, 0, 0x7C, 0xFC);
    }

    /** Stadium 2's Pokemon model-decoration particle frame: 32x32 I4. */
    public loadPokemonModelParticleI4TextureFrame(address: number): void {
        this.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
        this.gDPSetTextureImage(ImageFormat.G_IM_FMT_I, 0, 1, address);
        this.gDPSetTile(ImageFormat.G_IM_FMT_I, 0, 0, 0, 7, 0, 2, 0, 0, 2, 0, 0);
        this.gDPLoadBlock(7, 0, 0, 0x0FF, 0x400);
        this.gDPSetTile(ImageFormat.G_IM_FMT_I, 0, 2, 0, 0, 0, 2, 0, 0, 2, 0, 0);
        this.gDPSetTileSize(0, 0, 0, 0x7C, 0x7C);
    }

    /** fragment31's animated/scrolled 64x32 RGBA16 material callback. */
    public loadScrollingRGBA16TextureFrame(address: number, scroll: number): void {
        this.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
        this.gDPSetTextureImage(ImageFormat.G_IM_FMT_RGBA, 2, 64, address);
        this.gDPSetTile(ImageFormat.G_IM_FMT_RGBA, 2, 0, 0, 7, 0, 2, 5, 0, 0, 6, 0);
        this.gDPLoadBlock(7, 0, 0, 0x7FF, 0x100);
        this.gDPSetTile(ImageFormat.G_IM_FMT_RGBA, 2, 16, 0, 0, 0, 2, 5, 0, 0, 6, 0);
        this.gDPSetTileSize(0, scroll & 0x0FFF, 0, (scroll + 0xFC) & 0x0FFF, 0x7C);
    }

    public setFreeRunningTextureAnimation(variants: number[][]): void {
        this.stadiumTextureVariants = variants;
        this.stadiumFreeRunningTextureAnimation = true;
    }

    public setPokemonStadiumGsSelectedTextureAnimation(): void {
        this.stadiumGsSelectedTextureAnimation = true;
        this.stateChanged = true;
    }

    public setPokemonStadiumGsMaterialVariantTextureIndices(indices: number[]): void {
        this.stadiumGsMaterialVariantTextureIndices = [...indices];
        this.stateChanged = true;
    }

    public setPokemonStadiumGsCurrentPokemonTexture(enabled: boolean): void {
        this.stadiumGsCurrentPokemonTexture = enabled;
        this.stateChanged = true;
    }

    public setPokemonStadiumGsParticleVertexAlphaScale(enabled: boolean): void {
        this.stadiumGsParticleVertexAlphaScale = enabled;
        this.stateChanged = true;
    }

    public setPokemonStadiumGsModelParticleIndex(index: number, groupIndex: number = -1): void {
        this.stadiumGsModelParticleIndex = index;
        this.stadiumGsModelParticleGroupIndex = groupIndex;
        this.stateChanged = true;
    }

    public setParticlePrimitiveEnvironmentCombine(): void {
        this.stadiumParticlePrimitiveEnvironment = true;
    }

    public setDualTextureParticleColorCombine(): void {
        this.stadiumDualTextureParticleColor = true;
    }

    public setLeerEyeMask(enabled: boolean): void {
        this.stadiumLeerEyeMask = enabled;
    }


    public setModelParticleColorMode(mode: 'all' | 'alpha' | 'none'): void {
        this.stadiumModelParticleColorMode = mode;
    }

    /**
     * Submit the shared ten-vertex ribbon used by fragment31's animated IA8
     * callback. The source vertices are D_80077620 and the strip topology is
     * D_800776D8 in the game; only the generated vertex positions normally
     * change at runtime.
     */
    public drawAnimatedIA8Ribbon(): void {
        this.stadiumIA8Flame = true;
        // D_800762C8 and func_80032A7C: the common dynamic-model material
        // mixed the IA flame mask between a white primitive and orange env.
        this.gDPSetCombine(0x00309680, 0x5F1AFFFF);
        this.gSPSetPrimColor(0, 0xFF, 0xFF, 0xFF, 0xFF);
        this.gSPSetEnvColor(180, 32, 0, 0);
        const positions: readonly (readonly [number, number])[] = [
            [-50, 170], [-50, 120], [50, 120], [50, 170],
            [-50, 70], [50, 70], [-50, 20], [50, 20], [-50, -30], [50, -30],
        ];
        const textureCoordinates: readonly (readonly [number, number])[] = [
            [0, 0], [0, 16], [32, 16], [32, 0],
            [0, 32], [32, 32], [0, 48], [32, 48], [0, 64], [32, 64],
        ];
        const blue = [0, 0, 0, 0, 0, 0, 0xC0 / 0xFF, 0xC0 / 0xFF, 0x80 / 0xFF, 0x80 / 0xFF];
        for (let i = 0; i < positions.length; i++) {
            const vertex = this.vertexCache[i];
            vertex.outputIndex = -1;
            vertex.x = positions[i][0]; vertex.y = positions[i][1]; vertex.z = 0;
            vertex.tx = textureCoordinates[i][0]; vertex.ty = textureCoordinates[i][1];
            vertex.c0 = 1; vertex.c1 = 1; vertex.c2 = blue[i]; vertex.a = 1;
            vertex.matrixIndex = this.SP_MatrixIndex;
        }
        this.gSPClearGeometryMode(RSP_Geometry.G_LIGHTING | RSP_Geometry.G_CULL_FRONT | RSP_Geometry.G_CULL_BACK);
        this.gSPSetGeometryMode(RSP_Geometry.G_SHADE);
        const triangles = [
            0, 1, 2, 0, 2, 3,
            1, 4, 5, 1, 5, 2,
            4, 6, 7, 4, 7, 5,
            6, 8, 9, 6, 9, 7,
        ];
        for (let i = 0; i < triangles.length; i += 3)
            this.gSPTri(triangles[i], triangles[i + 1], triangles[i + 2]);
    }

    /** Submit a ROM-decoded generated ModelSegment template without species literals. */
    public drawGeneratedModelSegmentTemplate(template: {
        vertices: Array<{ position: number[]; texcoord: number[]; color: number[] }>;
        triangles: number[];
    }, vertexMatrixIndices?: readonly number[]): void {
        for (let i = 0; i < template.vertices.length; i++) {
            const source = template.vertices[i];
            const vertex = this.vertexCache[i];
            vertex.outputIndex = -1;
            vertex.x = source.position[0]; vertex.y = source.position[1]; vertex.z = source.position[2];
            vertex.tx = source.texcoord[0] / 0x20; vertex.ty = source.texcoord[1] / 0x20;
            vertex.c0 = source.color[0] / 0xFF; vertex.c1 = source.color[1] / 0xFF;
            vertex.c2 = source.color[2] / 0xFF; vertex.a = source.color[3] / 0xFF;
            vertex.matrixIndex = vertexMatrixIndices?.[i] ?? this.SP_MatrixIndex;
        }
        for (let i = 0; i < template.triangles.length; i += 3)
            this.gSPTri(template.triangles[i], template.triangles[i + 1], template.triangles[i + 2]);
    }

    public getCurrentTextureIndices(): number[] {
        if (!this.SP_TextureState.on || !this.DP_TMemTracker.has(this.DP_TileState[this.SP_TextureState.tile].tmem))
            return [];
        const drawCall = new DrawCall();
        drawCall.DP_Combine = RDP.decodeCombineParams(this.DP_CombineH, this.DP_CombineL);
        drawCall.DP_OtherModeH = this.DP_OtherModeH;
        try {
            this._flushTextures(drawCall);
        } catch {
            // Some material lists defer their TMEM load to the geometry list.
            return [];
        }
        return drawCall.textureIndices;
    }

    public finish(): RSPOutput | null {
        if (this.output.drawCalls.length === 0)
            return null;
        return this.output;
    }

    // partially reset the state to prepare for a new node
    public clear(): void {
        this.SP_MatrixIndex = 0;
        // start a new collection of drawcalls
        this.output = new RSPOutput();
        this.stateChanged = true;

        this.materialIndex = -1;
        // mark any existing vertices as belonging to the parent
        for (let i = 0; i < this.vertexCache.length; i++) {
            this.vertexCache[i].matrixIndex = 1;
            this.vertexCache[i].outputIndex = -1;
        }
    }

    private _setGeometryMode(newGeometryMode: number) {
        if (this.SP_GeometryMode === newGeometryMode)
            return;
        // Geometry lists can modify culling between triangle batches without
        // otherwise changing the active material.
        // keep track of this to properly share material across draw calls
        this.minorChange = true;
        this.SP_GeometryMode = newGeometryMode;
    }

    public gSPSetGeometryMode(mask: number): void {
        this._setGeometryMode(this.SP_GeometryMode | mask);
    }

    public gSPClearGeometryMode(mask: number): void {
        this._setGeometryMode(this.SP_GeometryMode & ~mask);
    }

    public gSPTexture(on: boolean, tile: number, level: number, s: number, t: number): void {
        // This is the texture we're using to rasterize triangles going forward.
        this.SP_TextureState.set(on, tile, level, s / 0x10000, t / 0x10000);
        this.stateChanged = true;
    }

    public gSPVertex(dramAddr: number, n: number, v0: number): void {
        const view = this.dataMap.getView(dramAddr);
        for (let i = 0; i < n; i++) {
            this.vertexCache[v0 + i].setFromView(view, i * 0x10);
            this.vertexCache[v0 + i].matrixIndex = this.SP_MatrixIndex;
            // Texture scale is part of the RSP vertex load operation.
            this.vertexCache[v0 + i].tx *= this.SP_TextureState.s;
            this.vertexCache[v0 + i].ty *= this.SP_TextureState.t;
        }
    }

    public gSPModifyVertex(w: number, n: number, upper: number, lower: number): void {
        const vtx = this.vertexCache[n];
        switch (w) {
            case 0x14: {
                // the provided values are already scaled, no need to adjust
                vtx.tx = (upper / 0x20) + 0.5;
                vtx.ty = (lower / 0x20) + 0.5;
            } break;
            default:
                throw new Error(`unsupported F3DEX2 G_MODIFYVTX field 0x${w.toString(16)}`);
        }
        vtx.outputIndex = -1;
    }

    private _translateTileTexture(tileIndex: number): number {
        let tile = this.DP_TileState[tileIndex];
        const trackedTexture = this.DP_TMemTracker.get(tile.tmem);
        if (trackedTexture === undefined)
            throw new Error(`texture tile ${tileIndex} references unloaded TMEM address 0x${tile.tmem.toString(16)}`);
        const dramAddr = trackedTexture;
        const descriptor = this.textureDescriptors.get(dramAddr);
        // A material can deliberately reinterpret bytes that are also exposed
        // through a graph texture descriptor. Leer does this at 0x40: the
        // descriptor is I8 64x64, while the material explicitly loads an I4
        // 32x32 tile. In that case the live RDP tile is authoritative.
        if (descriptor !== undefined && descriptor.fmt === tile.fmt && descriptor.siz === tile.siz) {
            const resourceTile = new RDP.TileState();
            resourceTile.copy(tile);
            resourceTile.fmt = descriptor.fmt;
            resourceTile.siz = descriptor.siz;
            resourceTile.line = Math.ceil(descriptor.width * getSizBitsPerPixel(descriptor.siz) / 64);
            // G_SETTILESIZE is also used as a scrolling window. Decode the
            // complete archived bitmap; the moving window must not truncate
            // the source texture in the host texture cache. Masks belong to
            // sampling, not source decoding: retaining a 5-bit mask here
            // truncated Grimer's 64x32 eye bitmap to 32x32 and repeated it.
            resourceTile.masks = 0;
            resourceTile.maskt = 0;
            resourceTile.setSize(0, 0, (descriptor.width - 1) << 2, (descriptor.height - 1) << 2);
            tile = resourceTile;
        }

        let dramPalAddr: number;
        if (tile.fmt === ImageFormat.G_IM_FMT_CI) {
            const textlut = (this.DP_OtherModeH >>> 14) & 0x03;
            // assert(textlut === TextureLUT.G_TT_RGBA16);

            const palTmem = 0x100 + (tile.palette << 4);
            const trackedPalette = this.DP_TMemTracker.get(palTmem);
            if (trackedPalette === undefined)
                throw new Error(`CI texture tile ${tileIndex} references unloaded TMEM palette 0x${palTmem.toString(16)}`);
            dramPalAddr = trackedPalette;
        } else {
            dramPalAddr = 0;
        }

        const segments: ArrayBufferSlice[] = [];
        const texAddr = addSegment(this.dataMap, segments, dramAddr);
        const palAddr = dramPalAddr === 0 ? 0 : addSegment(this.dataMap, segments, dramPalAddr);
        if (segments[texAddr >>> 24] === undefined)
            throw new Error(`texture address 0x${dramAddr.toString(16)} mapped to missing segment 0x${(texAddr >>> 24).toString(16)}`);
        if (this.DP_TMemLoadedByTile.has(tile.tmem)) {
            // G_LOADTILE copies tightly packed rows from the texture image into
            // a padded TMEM tile. We decode directly from DRAM, so using the
            // destination tile's line stride would walk into that nonexistent
            // padding (notably 42-wide RGBA16 Pokémon atlases).
            const sourceTile = new RDP.TileState();
            sourceTile.copy(tile);
            sourceTile.line = 0;
            const namespace = this.dataMap.textureCacheNamespace ?? 0;
            try {
                return this.sharedOutput.textureCache.translateTileTexture(segments, texAddr, palAddr, sourceTile, false,
                    namespace);
            } catch (error) {
                throw new Error(`failed to decode loaded tile texture 0x${dramAddr.toString(16)} as ${sourceTile.fmt}/${sourceTile.siz} ` +
                    `${RDP.getTileWidth(sourceTile)}x${RDP.getTileHeight(sourceTile)} from 0x${(texAddr & 0x00FFFFFF).toString(16)} ` +
                    `in ${segments[texAddr >>> 24].byteLength} bytes (line ${sourceTile.line}): ${error}`);
            }
        }
        const namespace = this.dataMap.textureCacheNamespace ?? 0;
        try {
            return this.sharedOutput.textureCache.translateTileTexture(segments, texAddr, palAddr, tile, false,
                namespace);
        } catch (error) {
            throw new Error(`failed to decode texture 0x${dramAddr.toString(16)} as ${tile.fmt}/${tile.siz} ` +
                `${((tile.lrs - tile.uls) >>> 2) + 1}x${((tile.lrt - tile.ult) >>> 2) + 1}: ${error}`);
        }
    }

    private _flushTextures(dc: F3DEX.DrawCall): void {
        // If textures are not on, then we have no textures.
        if (!this.SP_TextureState.on)
            return;

        const lod_en = !!((this.DP_OtherModeH >>> 16) & 0x01);
        if (lod_en) {
            // TODO(jstpierre): Support mip-mapping
            assert(false);
        } else {
            // We're in TILE mode. Now check if we're in two-cycle mode.
            const cycletype = RDP.getCycleTypeFromOtherModeH(this.DP_OtherModeH);
            assert(cycletype === RDP.OtherModeH_CycleType.G_CYC_1CYCLE || cycletype === RDP.OtherModeH_CycleType.G_CYC_2CYCLE);

            const stadiumDrawCall = dc as DrawCall;
            const samplingTile0 = new RDP.TileState();
            samplingTile0.copy(this.DP_TileState[this.SP_TextureState.tile]);
            stadiumDrawCall.stadiumTextureTiles.push(samplingTile0);
            const texture0 = this._translateTileTexture(this.SP_TextureState.tile);
            dc.textureIndices.push(texture0);

            if (this.SP_TextureState.level === 0 && RDP.combineParamsUsesT1(dc.DP_Combine)) {
                // In 2CYCLE mode, it uses tile and tile + 1.
                // Some display lists reference TEXEL1 only in a term whose
                // multiplier is zero. They consequently leave the second tile
                // unconfigured; hardware still has a value there, while trying
                // to decode the default RGBA4 tile would abort the whole draw.
                const tile1 = this.DP_TileState[this.SP_TextureState.tile + 1];
                const tile1Configured = tile1.line !== 0 || tile1.lrs !== 0 || tile1.lrt !== 0;
                const samplingTile1 = new RDP.TileState();
                samplingTile1.copy(tile1Configured ? tile1 : this.DP_TileState[this.SP_TextureState.tile]);
                stadiumDrawCall.stadiumTextureTiles.push(samplingTile1);
                dc.textureIndices.push(tile1Configured ? this._translateTileTexture(this.SP_TextureState.tile + 1) : texture0);
            }
        }
    }

    private _flushDrawCall(): void {
        if (this.stateChanged || this.minorChange) {
            // if we've already used this material, and major changes have happened, clear it
            if (this.materialIndex === this.output.currentDrawCall.materialIndex && this.stateChanged)
                this.materialIndex = -1;
            this.stateChanged = false;
            this.minorChange = false;

            const dc = this.output.newDrawCall(this.sharedOutput.indices.length);
            dc.SP_GeometryMode = this.SP_GeometryMode;
            dc.SP_TextureState.copy(this.SP_TextureState);
            dc.DP_Combine = RDP.decodeCombineParams(this.DP_CombineH, this.DP_CombineL);
            dc.DP_OtherModeH = this.DP_OtherModeH;
            dc.DP_OtherModeL = this.DP_OtherModeL;
            vec4.copy(dc.DP_PrimColor, this.DP_PrimColor);
            vec4.copy(dc.DP_EnvColor, this.DP_EnvColor);
            dc.DP_PrimLOD = this.DP_PrimLOD;
            dc.materialIndex = this.materialIndex;
            dc.stadiumLayer = this.stadiumLayer;
            dc.stadiumTextureVariants = this.stadiumTextureVariants;
            dc.stadiumMaterialAnimationChannel = this.stadiumMaterialAnimationChannel;
            dc.stadiumLightColors = this.stadiumLightColors.map((color) => [...color]);
            dc.stadiumLightDirections = this.stadiumLightDirections.map((direction) => [...direction]);
            dc.stadiumLightAnimations = this.stadiumLightAnimations.map((animation) => ({
                index: animation.index, period: animation.period, times: [...animation.times],
                colors: animation.colors.map((color) => [...color]),
            }));
            dc.stadiumAmbientColor = [...this.stadiumAmbientColor];
            dc.stadiumBillboard = this.stadiumBillboard;
            dc.stadiumDualTextureScroll = this.stadiumDualTextureScroll;
            dc.stadiumTextureScrollSpeeds = this.stadiumTextureScrollSpeeds;
            dc.stadiumFreeRunningTextureAnimation = this.stadiumFreeRunningTextureAnimation;
            dc.stadiumGsSelectedTextureAnimation = this.stadiumGsSelectedTextureAnimation;
            dc.stadiumGsMaterialVariantTextureIndices = [...this.stadiumGsMaterialVariantTextureIndices];
            dc.stadiumGsCurrentPokemonTexture = this.stadiumGsCurrentPokemonTexture;
            dc.stadiumGsParticleVertexAlphaScale = this.stadiumGsParticleVertexAlphaScale;
            dc.stadiumGsModelParticleIndex = this.stadiumGsModelParticleIndex;
            dc.stadiumGsModelParticleGroupIndex = this.stadiumGsModelParticleGroupIndex;
            dc.stadiumIA8Flame = this.stadiumIA8Flame;
            dc.stadiumParticlePrimitiveEnvironment = this.stadiumParticlePrimitiveEnvironment;
            dc.stadiumDualTextureParticleColor = this.stadiumDualTextureParticleColor;
            dc.stadiumLeerEyeMask = this.stadiumLeerEyeMask;
            dc.stadiumModelParticleColorMode = this.stadiumModelParticleColorMode;

            this._flushTextures(dc);
        }
    }

    public gSPTri(i0: number, i1: number, i2: number): void {
        this._flushDrawCall();
        this.sharedOutput.loadVertex(this.vertexCache[i0]);
        this.sharedOutput.loadVertex(this.vertexCache[i1]);
        this.sharedOutput.loadVertex(this.vertexCache[i2]);
        this.sharedOutput.indices.push(
            this.vertexCache[i0].outputIndex,
            this.vertexCache[i1].outputIndex,
            this.vertexCache[i2].outputIndex,
        );
        this.output.currentDrawCall.indexCount += 3;
    }

    public gDPSetTextureImage(fmt: number, siz: number, w: number, addr: number): void {
        this.DP_TextureImageState.set(fmt, siz, w, addr);
    }

    public gDPSetTile(fmt: number, siz: number, line: number, tmem: number, tile: number, palette: number, cmt: number, maskt: number, shiftt: number, cms: number, masks: number, shifts: number): void {
        this.DP_TileState[tile].set(fmt, siz, line, tmem, palette, cmt, maskt, shiftt, cms, masks, shifts);
        this.stateChanged = true;
    }

    public gDPLoadTLUT(tile: number, count: number): void {
        // Track the TMEM destination back to the originating DRAM address.
        const tmemDst = this.DP_TileState[tile].tmem;
        this.DP_TMemTracker.set(tmemDst, this.DP_TextureImageState.addr);
        this.DP_TMemLoadedByTile.delete(tmemDst);
    }

    public gDPLoadBlock(tileIndex: number, uls: number, ult: number, texels: number, dxt: number): void {
        // First, verify that we're loading the whole texture.
        assert(uls === 0 && ult === 0);
        // Verify that we're loading into LOADTILE.
        // assert(tileIndex === 7);

        const tile = this.DP_TileState[tileIndex];

        // Track the TMEM destination back to the originating DRAM address.
        this.DP_TMemTracker.set(tile.tmem, this.DP_TextureImageState.addr);
        this.DP_TMemLoadedByTile.delete(tile.tmem);
        this.stateChanged = true;
    }

    public gDPLoadTile(tileIndex: number, uls: number, ult: number, _lrs: number, _lrt: number): void {
        const tile = this.DP_TileState[tileIndex];
        const sourceX = uls >>> 2;
        const sourceY = ult >>> 2;
        const sourcePixel = sourceY * this.DP_TextureImageState.w + sourceX;
        const sourceByteOffset = sourcePixel * getSizBitsPerPixel(this.DP_TextureImageState.siz) >>> 3;
        this.DP_TMemTracker.set(tile.tmem, this.DP_TextureImageState.addr + sourceByteOffset);
        this.DP_TMemLoadedByTile.add(tile.tmem);
        this.stateChanged = true;
    }

    public gDPSetTileSize(tile: number, uls: number, ult: number, lrs: number, lrt: number): void {
        this.DP_TileState[tile].setSize(uls, ult, lrs, lrt);
        this.stateChanged = true;
    }

    public gDPSetOtherModeL(sft: number, len: number, w1: number): void {
        const mask = len >= 32 ? 0xFFFFFFFF : ((1 << len) - 1) << sft;
        const DP_OtherModeL = (this.DP_OtherModeL & ~mask) | (w1 & mask);
        if (DP_OtherModeL !== this.DP_OtherModeL) {
            this.DP_OtherModeL = DP_OtherModeL;
            this.stateChanged = true;
        }
    }

    public gDPSetOtherModeH(sft: number, len: number, w1: number): void {
        const mask = len >= 32 ? 0xFFFFFFFF : ((1 << len) - 1) << sft;
        const DP_OtherModeH = (this.DP_OtherModeH & ~mask) | (w1 & mask);
        if (DP_OtherModeH !== this.DP_OtherModeH) {
            this.DP_OtherModeH = DP_OtherModeH;
            this.stateChanged = true;
        }
    }

    public gDPSetCombine(w0: number, w1: number): void {
        if (this.DP_CombineH !== w0 || this.DP_CombineL !== w1) {
            this.DP_CombineH = w0;
            this.DP_CombineL = w1;
            this.stateChanged = true;
        }
    }

    public gSPSetPrimColor(lod: number, r: number, g: number, b: number, a: number) {
        vec4.set(this.DP_PrimColor, r / 0xFF, g / 0xFF, b / 0xFF, a / 0xFF);
        this.DP_PrimLOD = lod / 0xFF;
        this.stateChanged = true;
    }

    public gSPSetEnvColor(r: number, g: number, b: number, a: number) {
        vec4.set(this.DP_EnvColor, r / 0xFF, g / 0xFF, b / 0xFF, a / 0xFF);
        this.stateChanged = true;
    }

    public gSPResetMatrixStackDepth(value: number): void {
        this.SP_MatrixIndex = value;
    }
}

export enum F3DEX2_GBI {
    G_NOOP             = 0x00,

    // DMA
    G_VTX               = 0x01,
    G_MODIFYVTX         = 0x02,
    G_CULLDL            = 0x03,
    G_BRANCH_Z          = 0x04,
    G_TRI1              = 0x05,
    G_TRI2              = 0x06,
    G_QUAD              = 0x07,
    G_LINE3D            = 0x08,

    G_TEXTURE           = 0xD7,
    G_POPMTX            = 0xD8,
    G_GEOMETRYMODE      = 0xD9,
    G_MTX               = 0xDA,
    G_MOVEWORD          = 0XDB,
    G_DL                = 0xDE,
    G_ENDDL             = 0xDF,

    // RDP
    G_SETCIMG           = 0xFF,
    G_SETZIMG           = 0xFE,
    G_SETTIMG           = 0xFD,
    G_SETCOMBINE        = 0xFC,
    G_SETENVCOLOR       = 0xFB,
    G_SETPRIMCOLOR      = 0xFA,
    G_SETBLENDCOLOR     = 0xF9,
    G_SETFOGCOLOR       = 0xF8,
    G_SETFILLCOLOR      = 0xF7,
    G_FILLRECT          = 0xF6,
    G_SETTILE           = 0xF5,
    G_LOADTILE          = 0xF4,
    G_LOADBLOCK         = 0xF3,
    G_SETTILESIZE       = 0xF2,
    G_LOADTLUT          = 0xF0,
    G_RDPSETOTHERMODE   = 0xEF,
    G_SETPRIMDEPTH      = 0xEE,
    G_SETSCISSOR        = 0xED,
    G_SETCONVERT        = 0xEC,
    G_SETKEYR           = 0xEB,
    G_SETKEYFB          = 0xEA,
    G_RDPFULLSYNC       = 0xE9,
    G_RDPTILESYNC       = 0xE8,
    G_RDPPIPESYNC       = 0xE7,
    G_RDPLOADSYNC       = 0xE6,
    G_TEXRECTFLIP       = 0xE5,
    G_TEXRECT           = 0xE4,
    G_SETOTHERMODE_H    = 0xE3,
    G_SETOTHERMODE_L    = 0xE2,
    G_RDPHALF_1         = 0XE1,
}

export type dlRunner = (state: RSPState, addr: number) => void;

export function runDL_F3DEX2(state: RSPState, addr: number, subDLHandler: dlRunner = runDL_F3DEX2): void {
    const view = state.dataMap.getView(addr);
    for (let i = 0; i < view.byteLength; i += 0x08) {
        const w0 = view.getUint32(i + 0x00);
        const w1 = view.getUint32(i + 0x04);

        const cmd: F3DEX2_GBI = w0 >>> 24;
        switch (cmd) {
            case F3DEX2_GBI.G_ENDDL:
                return;

            case F3DEX2_GBI.G_GEOMETRYMODE:
                state.gSPClearGeometryMode(~(w0 & 0x00FFFFFF));
                state.gSPSetGeometryMode(w1);
                break;

            case F3DEX2_GBI.G_SETTIMG: {
                const fmt = (w0 >>> 21) & 0x07;
                const siz = (w0 >>> 19) & 0x03;
                const w = (w0 & 0x0FFF) + 1;
                state.gDPSetTextureImage(fmt, siz, w, w1);
            } break;

            case F3DEX2_GBI.G_SETTILE: {
                const fmt = (w0 >>> 21) & 0x07;
                const siz = (w0 >>> 19) & 0x03;
                const line = (w0 >>> 9) & 0x1FF;
                const tmem = (w0 >>> 0) & 0x1FF;
                const tile = (w1 >>> 24) & 0x07;
                const palette = (w1 >>> 20) & 0x0F;
                const cmt = (w1 >>> 18) & 0x03;
                const maskt = (w1 >>> 14) & 0x0F;
                const shiftt = (w1 >>> 10) & 0x0F;
                const cms = (w1 >>> 8) & 0x03;
                const masks = (w1 >>> 4) & 0x0F;
                const shifts = (w1 >>> 0) & 0x0F;
                state.gDPSetTile(fmt, siz, line, tmem, tile, palette, cmt, maskt, shiftt, cms, masks, shifts);
            } break;

            case F3DEX2_GBI.G_LOADTLUT: {
                const tile = (w1 >>> 24) & 0x07;
                const count = (w1 >>> 14) & 0x3FF;
                state.gDPLoadTLUT(tile, count);
            } break;

            case F3DEX2_GBI.G_LOADBLOCK: {
                const uls = (w0 >>> 12) & 0x0FFF;
                const ult = (w0 >>> 0) & 0x0FFF;
                const tile = (w1 >>> 24) & 0x07;
                const lrs = (w1 >>> 12) & 0x0FFF;
                const dxt = (w1 >>> 0) & 0x0FFF;
                state.gDPLoadBlock(tile, uls, ult, lrs, dxt);
            } break;

            case F3DEX2_GBI.G_LOADTILE: {
                const uls = (w0 >>> 12) & 0x0FFF;
                const ult = w0 & 0x0FFF;
                const tile = (w1 >>> 24) & 0x07;
                const lrs = (w1 >>> 12) & 0x0FFF;
                const lrt = w1 & 0x0FFF;
                state.gDPLoadTile(tile, uls, ult, lrs, lrt);
            } break;

            case F3DEX2_GBI.G_VTX: {
                const v0w = (w0 >>> 1) & 0xFF;
                const n = (w0 >>> 12) & 0xFF;
                const v0 = v0w - n;
                state.gSPVertex(w1, n, v0);
            } break;

            case F3DEX2_GBI.G_TRI1: {
                const i0 = ((w0 >>> 16) & 0xFF) / 2;
                const i1 = ((w0 >>> 8) & 0xFF) / 2;
                const i2 = ((w0 >>> 0) & 0xFF) / 2;
                state.gSPTri(i0, i1, i2);
            } break;

            case F3DEX2_GBI.G_TRI2: {
                {
                    const i0 = ((w0 >>> 16) & 0xFF) / 2;
                    const i1 = ((w0 >>> 8) & 0xFF) / 2;
                    const i2 = ((w0 >>> 0) & 0xFF) / 2;
                    state.gSPTri(i0, i1, i2);
                }
                {
                    const i0 = ((w1 >>> 16) & 0xFF) / 2;
                    const i1 = ((w1 >>> 8) & 0xFF) / 2;
                    const i2 = ((w1 >>> 0) & 0xFF) / 2;
                    state.gSPTri(i0, i1, i2);
                }
            } break;

            case F3DEX2_GBI.G_DL: {
                // Stadium fragment pointers are normalized into segment 0x0F
                // by the extractor. Unlike Pokémon Snap, segment 0x80 has no
                // special host-side dispatch semantics here.
                subDLHandler(state, w1);
                if ((w0 >>> 16) & 0xFF)
                    return;
            } break;

            case F3DEX2_GBI.G_RDPSETOTHERMODE: {
                state.gDPSetOtherModeH(0, 24, w0 & 0x00FFFFFF);
                state.gDPSetOtherModeL(0, 32, w1);
            } break;

            case F3DEX2_GBI.G_SETOTHERMODE_H: {
                const len = ((w0 >>> 0) & 0xFF) + 1;
                const sft = 0x20 - ((w0 >>> 8) & 0xFF) - len;
                state.gDPSetOtherModeH(sft, len, w1);
            } break;

            case F3DEX2_GBI.G_SETOTHERMODE_L: {
                const len = ((w0 >>> 0) & 0xFF) + 1;
                const sft = 0x20 - ((w0 >>> 8) & 0xFF) - len;
                state.gDPSetOtherModeL(sft, len, w1);
            } break;

            case F3DEX2_GBI.G_SETCOMBINE: {
                state.gDPSetCombine(w0 & 0x00FFFFFF, w1);
            } break;

            case F3DEX2_GBI.G_TEXTURE: {
                const level = (w0 >>> 11) & 0x07;
                let tile = (w0 >>> 8) & 0x07;
                const on = !!((w0 >>> 0) & 0x7F);
                const s = (w1 >>> 16) & 0xFFFF;
                const t = (w1 >>> 0) & 0xFFFF;
                state.gSPTexture(on, tile, level, s, t);
            } break;

            case F3DEX2_GBI.G_SETTILESIZE: {
                const uls = (w0 >>> 12) & 0x0FFF;
                const ult = (w0 >>> 0) & 0x0FFF;
                const tile = (w1 >>> 24) & 0x07;
                const lrs = (w1 >>> 12) & 0x0FFF;
                const lrt = (w1 >>> 0) & 0x0FFF;
                state.gDPSetTileSize(tile, uls, ult, lrs, lrt);
            } break;

            case F3DEX2_GBI.G_POPMTX: {
                // assumes we were at 0
                state.gSPResetMatrixStackDepth(1);
            } break;

            case F3DEX2_GBI.G_MTX: {
                throw new Error(`Stadium geometry display list contains an unexpected G_MTX to ${hexzero(w1, 8)}`);
            } break;

            case F3DEX2_GBI.G_SETPRIMCOLOR: {
                const lod = (w0 >>> 0) & 0xFF;
                const r = (w1 >>> 24) & 0xFF;
                const g = (w1 >>> 16) & 0xFF;
                const b = (w1 >>> 8) & 0xFF;
                const a = (w1 >>> 0) & 0xFF;
                state.gSPSetPrimColor(lod, r, g, b, a);
            } break;

            case F3DEX2_GBI.G_SETBLENDCOLOR: {
                const r = (w1 >>> 24) & 0xFF;
                const g = (w1 >>> 16) & 0xFF;
                const b = (w1 >>> 8) & 0xFF;
                const a = (w1 >>> 0) & 0xFF;
                //state.gSPSetBlendColor(r, g, b, a);
            } break;

            case F3DEX2_GBI.G_SETENVCOLOR: {
                const r = (w1 >>> 24) & 0xFF;
                const g = (w1 >>> 16) & 0xFF;
                const b = (w1 >>> 8) & 0xFF;
                const a = (w1 >>> 0) & 0xFF;
                state.gSPSetEnvColor(r, g, b, a);
            } break;

            case F3DEX2_GBI.G_BRANCH_Z: {
                runDL_F3DEX2(state, state.DP_Half1, subDLHandler);
                return; // assume this DL is just for selecting LOD
            } break;


            case F3DEX2_GBI.G_RDPHALF_1: {
                state.DP_Half1 = w1;
            } break;

            case F3DEX2_GBI.G_MODIFYVTX: {
                const w = (w0 >>> 16) & 0xFF;
                const n = (w0 >>> 1) & 0x7FFF;
                const upper = view.getInt16(i + 0x04);
                const lower = view.getInt16(i + 0x06);
                state.gSPModifyVertex(w, n, upper, lower);
            } break;

            case F3DEX2_GBI.G_MOVEWORD: {
                // TODO: lights
                // assert(((w0 >>> 16) & 0xFF) === 0x0A)
            } break;

            case F3DEX2_GBI.G_CULLDL:
            case F3DEX2_GBI.G_RDPFULLSYNC:
            case F3DEX2_GBI.G_RDPTILESYNC:
            case F3DEX2_GBI.G_RDPPIPESYNC:
            case F3DEX2_GBI.G_RDPLOADSYNC:
                // Implementation not necessary.
                break;

            default:
                console.error(`Unknown DL opcode: ${cmd.toString(16)} ${hexzero(i, 8)}`);
        }
    }
}
