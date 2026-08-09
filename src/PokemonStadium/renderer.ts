import { mat4, vec3 } from 'gl-matrix';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { colorNewFromRGBA } from '../Color.js';
import { CameraController, computeViewMatrix } from '../Camera.js';
import { RSPSharedOutput } from '../BanjoKazooie/f3dex.js';
import { RenderData, F3DEX_Program } from '../BanjoKazooie/render.js';
import { ImageFormat, TextFilt } from '../Common/N64/Image.js';
import * as RDP from '../Common/N64/RDP.js';
import { fillMatrix4x4, fillVec4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { makeAttachmentClearDescriptor, makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxBindingLayoutDescriptor, GfxDevice, GfxFormat, GfxTexture, makeTextureDescriptor2D } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { DrawCallInstance } from './render.js';
import * as F3DEX2 from './F3DEX2.js';
import { FakeTextureHolder } from '../TextureHolder.js';
import * as Viewer from '../viewer.js';
import * as UI from '../ui.js';
import { MoveEffectArchive, MoveEffectResolver } from './effects.js';
import { FragmentDataMap, PokemonAnimation, PokemonArchive, PokemonGeneratedGeometryRoot, PokemonGeoNode, PokemonMaterialAnimation, PokemonTextureDescriptor, fragmentBase } from './archive.js';
import { setMaterialCombine, zBufferedRenderModes } from './materials.js';
import { MoveEffectPreviewSide } from './move_effect_renderer.js';
import { PokemonModelPose, SelectedPokemonAnimation } from './model_pose.js';
import { implementedPokemonDrawCallbacks, pokemonDrawCallback } from './draw_callbacks.js';
import {
    implementedPokemonStadiumGsCallbackSemantics,
    isPokemonStadiumGsDirectDisplayListCallback,
} from '../PokemonStadiumGs/callback_semantics.js';
import { PokemonStadiumBattleTextArchive } from './battle_text.js';
import { BattleTextRenderer } from './battle_text_renderer.js';
import { PokemonAnimationController } from './animation_controller.js';
import { MoveEffectPreviewRenderer } from './move_effect_preview_renderer.js';
import {
    GeneratedGeometryTemplate, GeneratedRibbonState, initializeGeneratedRibbon, stepGeneratedRibbon,
} from '../PokemonStadiumGs/generated_geometry.js';
import { nextPokemonStadiumGsRandom, PokemonModelParticleSimulator } from '../PokemonStadiumGs/model_particles.js';

// sMaterialRenderConfigurations in the game: material-node indices select one of these RDP
// combine muxes. Keeping the unpacked form makes the decomp correspondence
// visible and avoids embedding unexplained command words.
const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 4, numSamplers: 2 },
];

const viewMatrixScratch = mat4.create();
const lookatScratch = vec3.create();
const lookatMatrixScratch = mat4.create();

export class PokemonStadiumRenderer implements Viewer.SceneGfx {
    public onstatechanged!: () => void;
    public textureHolder = new FakeTextureHolder([]);
    private renderHelper: GfxRenderHelper;
    private renderInstList = new GfxRenderInstList();
    private pokemonCaptureRenderInstList = new GfxRenderInstList();
    private pokemonCaptureColor: GfxTexture;
    private pokemonCaptureDepth: GfxTexture;
    private renderData: RenderData;
    private drawCalls: DrawCallInstance[] = [];
    private modelMatrix = mat4.create();
    private dataView: DataView;
    private geoNodes: PokemonGeoNode[];
    private callbackSubtrees: boolean[];
    private modelPose: PokemonModelPose;
    private decalNodes = new Set<number>();
    private animations: PokemonAnimation[];
    private moveAnimationIDs: number[] = [];
    private moveEffectAttachmentIDs: number[][] = [];
    private moveEffectStartFrames: number[] = [];
    private naturalMoveIDs: number[] = [];
    private legalMoveIDs: number[] = [];
    private reactionAnimationIDs = new Set<number>();
    private animationController: PokemonAnimationController;
    private isPokemon: boolean;
    private materialAnimationBySkeletalIndex: (PokemonMaterialAnimation | null)[];
    private modelCenter = vec3.create();
    private modelSize = vec3.fromValues(120, 120, 120);
    private modelRadius = 60;
    private clearPass = standardFullClearRenderPassDescriptor;
    /** Zero is Auto; 1..165 is an explicit UI override. */
    private selectedMove = 0;
    private moveSelect: UI.Slider | null = null;
    private moveEffectsEnabled = true;
    private activeAnimationEffectKey = '';
    private animationEffectFrame = 0;
    private moveEffectStatus: HTMLElement | null = null;
    private activeEffectDescription = 'Waiting for animation';
    private selectedMoveEffectPreviewSide: MoveEffectPreviewSide = 'attacker';
    private moveEffectPreviewSide: MoveEffectPreviewSide = 'attacker';
    private moveEffectResolver: MoveEffectResolver;
    private moveEffectPreview: MoveEffectPreviewRenderer;
    private warnedDrawCallbacks = new Set<number>();
    private animationVisibilityDraws: DrawCallInstance[] = [];
    private stadiumGsSelectedTextureDraws: DrawCallInstance[] = [];
    private stadiumGsMaterialTextureVariantDraws: DrawCallInstance[] = [];
    private stadiumGsStageColorDraws: DrawCallInstance[] = [];
    private stadiumGsStageColor: readonly [number, number, number, number] = [1, 1, 1, 0];
    private stadiumGsMaterialTextureVariant = 0;
    private stadiumGsMaterialTextureVariantCount = 0;
    private battleTextRenderer: BattleTextRenderer | null = null;
    private animationTimeOrigin: number | null = null;
    private generatedGeometryRoot: PokemonGeneratedGeometryRoot | null = null;
    private generatedRibbonInstances: Array<{
        template: GeneratedGeometryTemplate;
        state: GeneratedRibbonState;
        baseMatrix: mat4;
        vertexMatrices: mat4[];
        lastFrame: number;
    }> = [];
    private pokemonModelParticleGroups: Array<{
        simulator: PokemonModelParticleSimulator;
        baseMatrix: mat4;
        parentMatrix: mat4 | null;
        matrices: mat4[];
        draws: DrawCallInstance[][];
        callbackOrdinal: number;
        lastFrame: number;
        randomInitialState: number;
        randomState: number;
    }> = [];

    constructor(private device: GfxDevice, archive: PokemonArchive, private moveEffectArchive: MoveEffectArchive,
        private battleText?: PokemonStadiumBattleTextArchive, variant: number = 0) {
        this.renderHelper = new GfxRenderHelper(device);
        this.pokemonCaptureColor = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_RT, 32, 32, 1));
        this.pokemonCaptureDepth = device.createTexture(makeTextureDescriptor2D(GfxFormat.D24, 32, 32, 1));
        this.moveEffectResolver = new MoveEffectResolver(moveEffectArchive);
        const dataMap = new FragmentDataMap(archive.Data);
        const sharedOutput = new RSPSharedOutput();
        // func_80015094 installs the model graph's inherited RDP state before
        // traversal. Material lists only update selected fields.
        const modelOtherModeH = TextFilt.G_TF_BILERP << RDP.OtherModeH_Layout.G_MDSFT_TEXTFILT;
        const state = new F3DEX2.RSPState(sharedOutput, dataMap, modelOtherModeH);
        // Battle scenes install an ambient/directional light node before
        // traversing the Pokémon model. The archived model graph assumes that
        // external state and stores normals in the vertex color bytes.
        state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
            F3DEX2.RSP_Geometry.G_CULL_BACK | F3DEX2.RSP_Geometry.G_LIGHTING |
            F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
        state.gDPSetOtherModeH(20, 2, 1 << 20);
        this.dataView = archive.Data.createDataView();
        const model = archive.Pokemon ?? archive.Stadium;
        this.isPokemon = archive.Pokemon != null;
        this.generatedGeometryRoot = archive.Pokemon?.GeneratedGeometryRoot ?? null;
        this.stadiumGsMaterialTextureVariantCount = archive.Pokemon?.MaterialTextureVariantCount ?? 0;
        const speciesID = archive.Pokemon?.SpeciesID ?? -1;
        if (battleText !== undefined) this.battleTextRenderer = new BattleTextRenderer(battleText, speciesID);
        const battleScale = archive.Pokemon?.BattleScale ?? 1;
        if (this.isPokemon) {
            this.clearPass = makeAttachmentClearDescriptor(colorNewFromRGBA(0.18, 0.18, 0.18, 1));
        } else {
            const background = archive.Stadium!.Background >>> 0;
            const rgba16 = background === 0xFFFFFFFF ? 1 : background & 0xFFFF;
            const r = (rgba16 >>> 11 & 0x1F) / 0x1F;
            const g = (rgba16 >>> 6 & 0x1F) / 0x1F;
            const b = (rgba16 >>> 1 & 0x1F) / 0x1F;
            this.clearPass = makeAttachmentClearDescriptor(colorNewFromRGBA(r, g, b, 1));
        }
        if (model === undefined || model.GeoNodes.length === 0) throw new Error('archive contains no model graph');
        for (const node of model.GeoNodes.flat()) {
            for (const texture of node.Textures) {
                if (texture.DataOffset >= 0)
                    state.registerTextureDescriptor(fragmentBase + texture.DataOffset,
                        texture.Format, texture.Size, texture.Width, texture.Height);
            }
        }
        if (variant < 0) {
            this.geoNodes = [];
            const receiverPlanes = new Set<number>();
            for (let layoutIndex = 0; layoutIndex < model.GeoNodes.length; layoutIndex++) {
                const layout = model.GeoNodes[layoutIndex];
                const base = this.geoNodes.length;
                this.geoNodes.push(...layout.map((node) => ({
                    ...node,
                    Parent: node.Parent < 0 ? -1 : node.Parent + base,
                })));
                if (!this.isPokemon) {
                    for (let i = 0; i < layout.length; i++) {
                        const node = layout[i];
                        if (node.DisplayList < 0) continue;
                        const planeY = this.getDisplayListPlaneY(node.DisplayList);
                        if (planeY === null) continue;
                        if (receiverPlanes.has(planeY)) this.decalNodes.add(base + i);
                        else receiverPlanes.add(planeY);
                    }
                }
            }
        } else {
            this.geoNodes = model.GeoNodes[Math.min(variant, model.GeoNodes.length - 1)];
        }
        this.animations = archive.Pokemon?.Animations ?? [];
        this.moveAnimationIDs = archive.Pokemon?.MoveAnimationIDs ?? [];
        const moveAnimationFrequencies = archive.Pokemon?.MoveAnimationFrequencies ?? [];
        this.moveEffectAttachmentIDs = archive.Pokemon?.MoveEffectAttachmentIDs ?? [];
        this.moveEffectStartFrames = archive.Pokemon?.MoveEffectStartFrames ?? [];
        this.naturalMoveIDs = archive.Pokemon?.NaturalMoveIDs ?? [];
        this.legalMoveIDs = archive.Pokemon?.LegalMoveIDs ?? [];
        this.reactionAnimationIDs = new Set(archive.Pokemon?.ReactionAnimationIDs ?? []);
        this.animationController = new PokemonAnimationController({
            Animations: this.animations,
            MoveAnimationIDs: this.moveAnimationIDs,
            MoveAnimationFrequencies: moveAnimationFrequencies,
            MoveEffectStartFrames: this.moveEffectStartFrames,
            NaturalMoveIDs: this.naturalMoveIDs,
            LegalMoveIDs: this.legalMoveIDs,
            MoveEffectResolver: this.moveEffectResolver,
        });
        // The game selects skeletal and material animations independently.
        // Equal frame counts do not establish a relationship between them;
        // guessing that pairing replaces unrelated base textures (Grimer's
        // 32x32 puddle was incorrectly assigned a 64x32 limb texture).
        this.materialAnimationBySkeletalIndex = this.animations.map(() => null);
        this.modelPose = new PokemonModelPose(this.dataView, this.geoNodes, this.modelMatrix);
        this.callbackSubtrees = this.geoNodes.map(() => false);
        const markCallbackSubtree = (index: number): boolean => {
            let hasCallback = this.geoNodes[index].DrawCallback !== 0;
            for (const child of this.modelPose.geoChildren[index]) hasCallback = markCallbackSubtree(child) || hasCallback;
            return this.callbackSubtrees[index] = hasCallback;
        };
        for (const root of this.modelPose.geoRoots) markCallbackSubtree(root);
        this.modelPose.update(this.selectAnimation(0));

        const drawMatrices: mat4[] = [];
        const stageColorMatrixIndices = new Set<number>();
        const matrixIndices = new Map<mat4, number>();
        const matrixIndex = (matrix: mat4): number => {
            let index = matrixIndices.get(matrix);
            if (index === undefined) {
                index = drawMatrices.length;
                drawMatrices.push(matrix);
                matrixIndices.set(matrix, index);
            }
            return index;
        };
        const runGeometry = (offset: number, matrix: mat4, layer: number, decal: boolean, billboard: number,
            drawCallback: number, drawCallbackArgument: number, drawCallbackSemantic?: string,
            drawCallbackData?: Record<string, unknown>, parentMatrix: mat4 | null = null): void => {
            // Callback graph nodes generate their display list at runtime and
            // therefore deliberately carry no static display-list pointer.
            if (offset < 0 && drawCallback === 0) return;
            // The third stadium graph supplies coplanar court markings. Route
            // those through the same N64 decal queues used by other games:
            // opaque ZMODE_DEC for solid marks, translucent ZMODE_DEC for the
            // alpha queues. RDP translation then supplies the native decal
            // depth comparison and write behavior.
            const sourceQueue = layer & 0x0F;
            const queue = decal ? (sourceQueue >= 5 ? 6 : 2) : sourceQueue;
            const callbackBillboard = drawCallback === pokemonDrawCallback.AnimatedIA8Ribbon ||
                drawCallbackSemantic === 'BuildPokemonModelParticleDisplayListCallback' ? 16 : billboard;
            const finishRenderQueue = state.beginRenderQueue(queue, callbackBillboard);
            state.setMatrixIndex(matrixIndex(matrix));
            if (drawCallbackSemantic === 'ApplyStageNodeScaleAndColorCallback')
                stageColorMatrixIndices.add(matrixIndex(matrix));
            state.gDPSetOtherModeL(0, 32, (zBufferedRenderModes[queue] ?? zBufferedRenderModes[0]) | 0x0C080000);
            let callbackReplacedDisplayList = false;
            let callbackUpdatesMaterial = false;
            if (drawCallbackArgument >= 0) {
                if (isPokemonStadiumGsDirectDisplayListCallback(drawCallbackSemantic)) {
                    // Stadium 2 serializes the display-list pointer directly as
                    // the callback argument. The phase-5 callbacks submit it
                    // through the shared draw helper with model mode 0, 1, or 2.
                    F3DEX2.runDL_F3DEX2(state, fragmentBase + drawCallbackArgument);
                    callbackReplacedDisplayList = true;
                } else if (drawCallbackSemantic === 'BuildConditionalModelDisplayListCallback' ||
                    drawCallbackSemantic === 'BuildDualConditionalModelDisplayListCallback') {
                    // ModelRenderObject byte +0x1C starts at zero. The callback
                    // emits list 0 only while it remains zero; the dual form
                    // always emits list 1. Battle move controllers set it to
                    // 1/2 for a handful of move-specific frames. Static archive
                    // rendering represents the initialized (zero) state.
                    const lists = drawCallbackData?.display_lists ??
                        (drawCallbackData?.display_list === undefined ? [] : [drawCallbackData.display_list]);
                    if (!Array.isArray(lists) || lists.length === 0)
                        throw new Error(`${drawCallbackSemantic} has no validated display-list pointers`);
                    for (const list of lists) {
                        const pointer = list as { offset?: unknown };
                        if (typeof pointer.offset !== 'number')
                            throw new Error(`${drawCallbackSemantic} has an invalid display-list pointer`);
                        F3DEX2.runDL_F3DEX2(state, fragmentBase + pointer.offset);
                    }
                    callbackReplacedDisplayList = true;
                } else if (drawCallbackSemantic === 'BuildTextureSequenceDisplayListCallback') {
                    // BuildTextureSequenceRgba16DisplayList selects one of
                    // eight 64x32 RGBA16 images from argument +0x04 using the
                    // 30 Hz global frame modulo eight. Its signed s16 at +0x00
                    // advances the render-tile S origin every battle frame.
                    const variants: number[][] = [];
                    for (let frame = 0; frame < 8; frame++) {
                        const texture = this.dataView.getUint32(drawCallbackArgument + 4 + frame * 4) & 0x000FFFFF;
                        state.loadScrollingRGBA16TextureFrame(fragmentBase + texture, 0);
                        variants.push(state.getCurrentTextureIndices());
                    }
                    const texture = this.dataView.getUint32(drawCallbackArgument + 4) & 0x000FFFFF;
                    const scrollSpeed = this.dataView.getInt16(drawCallbackArgument);
                    state.loadScrollingRGBA16TextureFrame(fragmentBase + texture, 0);
                    state.setFreeRunningTextureAnimation(variants);
                    state.setTextureScrollSpeeds([[scrollSpeed, 0]]);
                    callbackReplacedDisplayList = true;
                    callbackUpdatesMaterial = true;
                } else if (drawCallbackSemantic === 'BuildDualTextureScrollDisplayListCallback') {
                    // BuildDualScrollingRgba16TextureDisplayList loads the two
                    // RGBA16 32x32 pointers at +0x00/+0x04. At global frame F,
                    // tile 0 uses (-F, +F) and tile 1 uses (+F, +2F) in 10.2
                    // coordinates; texture-matrix signs account for RDP UL.
                    const texture0 = this.dataView.getUint32(drawCallbackArgument) & 0x000FFFFF;
                    const texture1 = this.dataView.getUint32(drawCallbackArgument + 4) & 0x000FFFFF;
                    state.runDualTextureScrollPass(fragmentBase + texture0, fragmentBase + texture1, 0, false);
                    state.setTextureScrollSpeeds([[-1, -1], [1, -2]]);
                    callbackReplacedDisplayList = true;
                    callbackUpdatesMaterial = true;
                } else if (drawCallbackSemantic === 'BuildSelectedTextureDisplayListCallback') {
                    // Resource 88 supplies eight RGBA16 32x32 pointers at
                    // argument +0x04. Runtime selection is coupled to the
                    // active skeletal clip/frame, not a free-running clock.
                    const variants: number[][] = [];
                    for (let frame = 0; frame < 8; frame++) {
                        const texture = this.dataView.getUint32(drawCallbackArgument + 4 + frame * 4) & 0x000FFFFF;
                        state.loadPuddleTextureFrame(fragmentBase + texture);
                        variants.push(state.getCurrentTextureIndices());
                    }
                    const texture = this.dataView.getUint32(drawCallbackArgument + 4) & 0x000FFFFF;
                    state.loadPuddleTextureFrame(fragmentBase + texture);
                    state.setTextureVariants(variants);
                    state.setPokemonStadiumGsSelectedTextureAnimation();
                    callbackReplacedDisplayList = true;
                    callbackUpdatesMaterial = true;
                } else if (drawCallbackSemantic === 'HandleFrameSelectedIa16ModelSegmentCallback') {
                    const template = this.generatedGeometryRoot?.model_segment_template;
                    if (template === null || template === undefined)
                        throw new Error('generated ModelSegment callback has no decoded template');
                    const variants: number[][] = [];
                    for (let frame = 0; frame < 8; frame++) {
                        const texture = this.dataView.getUint32(drawCallbackArgument + 8 + frame * 4) & 0x000FFFFF;
                        state.loadGeneratedSegmentIA16TextureFrame(fragmentBase + texture);
                        variants.push(state.getCurrentTextureIndices());
                    }
                    const texture = this.dataView.getUint32(drawCallbackArgument + 8) & 0x000FFFFF;
                    state.loadGeneratedSegmentIA16TextureFrame(fragmentBase + texture);
                    state.setFreeRunningTextureAnimation(variants);
                    const ribbonState = initializeGeneratedRibbon(template);
                    const vertexMatrices = template.vertices.map(() => mat4.clone(matrix));
                    const vertexMatrixIndices = vertexMatrices.map((vertexMatrix) => matrixIndex(vertexMatrix));
                    state.drawGeneratedModelSegmentTemplate(template, vertexMatrixIndices);
                    this.generatedRibbonInstances.push({
                        template, state: ribbonState, baseMatrix: matrix,
                        vertexMatrices, lastFrame: -1,
                    });
                    callbackReplacedDisplayList = true;
                    callbackUpdatesMaterial = true;
                } else if (drawCallbackSemantic === 'BuildPokemonModelParticleDisplayListCallback') {
                    // The callback argument is a resource bundle: setup DL,
                    // draw/restore DL, then eight 32x32 I4 animation frames.
                    const callbackOrdinal = this.pokemonModelParticleGroups.length;
                    const sharedSimulator = this.pokemonModelParticleGroups[0]?.simulator ??
                        new PokemonModelParticleSimulator(
                            speciesID, archive.Pokemon?.ModelParticleAnimationSchedule,
                        );
                    const particleMatrices = callbackOrdinal === 0
                        ? Array.from({ length: 10 }, () => mat4.clone(matrix)) : [];
                    const particleGroup = {
                        simulator: sharedSimulator, baseMatrix: matrix, parentMatrix,
                        matrices: particleMatrices, draws: Array.from({ length: 10 }, () => [] as DrawCallInstance[]),
                        callbackOrdinal,
                        lastFrame: -1,
                        randomInitialState: archive.Pokemon?.ModelParticleRandomInitialState ?? 0,
                        randomState: archive.Pokemon?.ModelParticleRandomInitialState ?? 0,
                    };
                    this.pokemonModelParticleGroups.push(particleGroup);
                    // Only ordinal zero allocates 0x500 bytes and builds the
                    // shared pool's display list. Later callback nodes allocate
                    // only an ENDDL-sized buffer after running their scheduler.
                    if (callbackOrdinal === 0) {
                    const setupDisplayList = this.dataView.getUint32(drawCallbackArgument) & 0x000FFFFF;
                    const drawDisplayList = this.dataView.getUint32(drawCallbackArgument + 4) & 0x000FFFFF;
                    const variants: number[][] = [];
                    for (let frame = 0; frame < 8; frame++) {
                        const texture = this.dataView.getUint32(drawCallbackArgument + 8 + frame * 4) & 0x000FFFFF;
                        const address = fragmentBase + texture;
                        state.registerTextureDescriptor(address, ImageFormat.G_IM_FMT_I, 0, 32, 32);
                        state.loadPokemonModelParticleI4TextureFrame(address);
                        variants.push(state.getCurrentTextureIndices());
                    }
                    const firstTexture = this.dataView.getUint32(drawCallbackArgument + 8) & 0x000FFFFF;
                    state.loadPokemonModelParticleI4TextureFrame(fragmentBase + firstTexture);
                    state.setTextureVariants(variants);
                    state.gSPSetPrimColor(0, 10, 0, 0, 200);
                    for (let particleIndex = 0; particleIndex < 10; particleIndex++) {
                        state.setMatrixIndex(matrixIndex(particleMatrices[particleIndex]));
                        state.setPokemonStadiumGsModelParticleIndex(
                            particleIndex, particleGroup.callbackOrdinal,
                        );
                        F3DEX2.runDL_F3DEX2(state, fragmentBase + setupDisplayList);
                        F3DEX2.runDL_F3DEX2(state, fragmentBase + drawDisplayList);
                    }
                    state.setPokemonStadiumGsModelParticleIndex(-1);
                    callbackUpdatesMaterial = true;
                    }
                    callbackReplacedDisplayList = true;
                } else if (drawCallback === pokemonDrawCallback.DualTextureScroll) {
                    const texture0 = this.dataView.getUint32(drawCallbackArgument) & 0x000FFFFF;
                    const texture1 = this.dataView.getUint32(drawCallbackArgument + 4) & 0x000FFFFF;
                    state.runDualTextureScrollPass(fragmentBase + texture0, fragmentBase + texture1, 0);
                    callbackReplacedDisplayList = true;
                    callbackUpdatesMaterial = true;
                } else if (drawCallback === pokemonDrawCallback.ExternalDisplayList) {
                    const displayList = this.dataView.getUint32(drawCallbackArgument) & 0x000FFFFF;
                    F3DEX2.runDL_F3DEX2(state, fragmentBase + displayList);
                    callbackReplacedDisplayList = true;
                } else if (drawCallback === pokemonDrawCallback.AnimatedIA8Ribbon) {
                    const variants: number[][] = [];
                    for (let frame = 0; frame < 8; frame++) {
                        const texture = this.dataView.getUint32(drawCallbackArgument + 8 + frame * 4) & 0x000FFFFF;
                        state.loadAnimatedIA8TextureFrame(fragmentBase + texture);
                        variants.push(state.getCurrentTextureIndices());
                    }
                    const texture = this.dataView.getUint32(drawCallbackArgument + 8) & 0x000FFFFF;
                    state.loadAnimatedIA8TextureFrame(fragmentBase + texture);
                    state.setFreeRunningTextureAnimation(variants);
                    state.drawAnimatedIA8Ribbon();
                    callbackReplacedDisplayList = true;
                } else if (drawCallback === pokemonDrawCallback.TwoDisplayLists) {
                    for (let pointer = 0; pointer < 2; pointer++) {
                        const displayList = this.dataView.getUint32(drawCallbackArgument + pointer * 4) & 0x000FFFFF;
                        F3DEX2.runDL_F3DEX2(state, fragmentBase + displayList);
                    }
                    callbackReplacedDisplayList = true;
                } else if (drawCallback === pokemonDrawCallback.ScrollingRGBA16) {
                    const variants: number[][] = [];
                    for (let frame = 0; frame < 8; frame++) {
                        const texture = this.dataView.getUint32(drawCallbackArgument + 4 + frame * 4) & 0x000FFFFF;
                        state.loadScrollingRGBA16TextureFrame(fragmentBase + texture, 0);
                        variants.push(state.getCurrentTextureIndices());
                    }
                    const texture = this.dataView.getUint32(drawCallbackArgument + 4) & 0x000FFFFF;
                    const scrollSpeed = this.dataView.getInt16(drawCallbackArgument);
                    state.loadScrollingRGBA16TextureFrame(fragmentBase + texture, 0);
                    state.setFreeRunningTextureAnimation(variants);
                    state.setTextureScrollSpeeds([[scrollSpeed, 0]]);
                    callbackReplacedDisplayList = true;
                    callbackUpdatesMaterial = true;
                } else if (drawCallback === pokemonDrawCallback.PuddleTexture) {
                    // update_grimer_muk_puddle_texture selects textures[index + 1], with an
                    // eight-frame free-running fallback outside animation 58.
                    // Translate every callback frame once and let the draw
                    // instance select the live frame at render time.
                    const variants: number[][] = [];
                    for (let frame = 0; frame < 8; frame++) {
                        const texture = this.dataView.getUint32(drawCallbackArgument + 4 + frame * 4) & 0x000FFFFF;
                        state.loadPuddleTextureFrame(fragmentBase + texture);
                        variants.push(state.getCurrentTextureIndices());
                    }
                    const restingTexture = this.dataView.getUint32(drawCallbackArgument + 4) & 0x000FFFFF;
                    state.loadPuddleTextureFrame(fragmentBase + restingTexture);
                    state.setFreeRunningTextureAnimation(variants);
                    callbackReplacedDisplayList = true;
                    callbackUpdatesMaterial = true;
                } else if (drawCallback === pokemonDrawCallback.EmptyModelParticlePool) {
                    // render_model_particles_callback draws a fragment31-owned ten-slot
                    // particle pool. Spawning and updating that pool requires the live
                    // battle actor, so its initialized standalone-viewer state is empty.
                    callbackReplacedDisplayList = true;
                }
            }
            const implementedSemantic = drawCallbackSemantic !== undefined &&
                implementedPokemonStadiumGsCallbackSemantics.has(drawCallbackSemantic as never);
            if (drawCallback !== 0 && !implementedSemantic && !implementedPokemonDrawCallbacks.has(drawCallback) && !this.warnedDrawCallbacks.has(drawCallback)) {
                this.warnedDrawCallbacks.add(drawCallback);
                console.warn(`Pokémon Stadium draw callback 0x${drawCallback.toString(16)} (${drawCallbackSemantic ?? 'unknown semantic'}) is not implemented`);
            }
            if (callbackUpdatesMaterial)
                state.commitMaterialState();
            try {
                if (!callbackReplacedDisplayList && offset >= 0)
                    F3DEX2.runDL_F3DEX2(state, fragmentBase + offset);
            } finally {
                finishRenderQueue();
            }
        };
        const runLayout = (nodes: PokemonGeoNode[]): void => {
            const activeMatrixSlots: (mat4 | null)[] = [];
            const lightColors: number[][] = [];
            const lightDirections: number[][] = [];
            const ambientColor = [0, 0, 0];
            const walk = (index: number, resources: PokemonTextureDescriptor[], palettes: PokemonTextureDescriptor[], billboard: number): void => {
                const node = nodes[index];
                const activeBillboard = node.Command === 0x1D && (node.TransformMode & 2) !== 0 ? 8 : billboard;
                const matrix = this.modelPose.nodeMatrices[index];
                const activeResources = node.Textures.length !== 0 ? node.Textures : resources;
                const activePalettes = node.Palettes.length !== 0 ? node.Palettes : palettes;
                const previousSlotMatrix = node.MatrixSlot >= 0 ? activeMatrixSlots[node.MatrixSlot] : null;
                // Callback-driven model branches install temporary draw state
                // before their geometry. Keep that state local until the
                // callback implementations themselves are decoded below.
                const restoreCallbackState = node.Command === 0x1D && this.callbackSubtrees[index]
                    ? state.pushDisplayListState() : null;
                if (node.Command === 0x1D && node.MatrixSlot >= 0) activeMatrixSlots[node.MatrixSlot] = matrix;

                if (node.Command === 0x14 && lightColors.length < 7) {
                    let lightAngles = node.LightAngles;
                    let lightColor = node.LightColor.slice(0, 3);
                    const magcargoLight = node.DrawCallbackSemantic === 'UpdateMagcargoShellLightColorAndDirectionCallback' &&
                        node.DrawCallbackArgument >= 0;
                    if (magcargoLight) {
                        const orientation = this.dataView.getInt16(node.DrawCallbackArgument);
                        lightAngles = [-0x1800 * 360 / 0x10000, (orientation === 0 ? -0x2000 : 0x2000) * 360 / 0x10000];
                        const timesOffset = this.dataView.getUint32(node.DrawCallbackArgument + 8) & 0x000FFFFF;
                        const colorsOffset = this.dataView.getUint32(node.DrawCallbackArgument + 0x10) & 0x000FFFFF;
                        const keyCount = this.dataView.getInt16(node.DrawCallbackArgument + 4);
                        const period = this.dataView.getInt16(node.DrawCallbackArgument + 2);
                        const times = Array.from({ length: keyCount }, (_, i) => this.dataView.getUint16(timesOffset + i * 2));
                        const colors = Array.from({ length: keyCount }, (_, i) => [
                            this.dataView.getUint8(colorsOffset + i * 4), this.dataView.getUint8(colorsOffset + i * 4 + 1),
                            this.dataView.getUint8(colorsOffset + i * 4 + 2),
                        ]);
                        lightColor = colors[0];
                        state.setLightAnimation(lightColors.length, period, times, colors);
                    }
                    const latitude = lightAngles[0] * Math.PI / 180;
                    const longitude = lightAngles[1] * Math.PI / 180;
                    lightColors.push(lightColor.map((component) => component / 255));
                    lightDirections.push([
                        Math.cos(latitude) * Math.sin(longitude),
                        Math.sin(latitude),
                        Math.cos(latitude) * Math.cos(longitude),
                    ]);
                    for (let component = 0; component < 3; component++)
                        ambientColor[component] = Math.min(1, ambientColor[component] + node.LightColor[component] * node.LightColor[3] / 100 / 255);
                    state.setLights(lightColors, lightDirections, ambientColor);
                } else if (node.Command === 0x16) {
                    if (node.LightColor[0] !== 0xFF || node.LightColor[1] !== 0xFF || node.LightColor[2] !== 0xFF) {
                        for (let component = 0; component < 3; component++) ambientColor[component] = node.LightColor[component] / 255;
                    }
                    state.setLights(lightColors, lightDirections, ambientColor);
                } else if (node.Command === 0x23) {
                    const applyMaterial = () => {
                        // An authored material terminates any callback-generated
                        // texture pass inherited from preceding geometry.
                        state.clearGeneratedTexturePass();
                        setMaterialCombine(state, node.MaterialFlags);
                        const color = node.MaterialFlags === 1 ? 0xFFFFFFFF : node.Color;
                        state.gSPSetPrimColor(0xFF, color >>> 24, color >>> 16 & 0xFF, color >>> 8 & 0xFF, color & 0xFF);
                        if (node.PaletteIndex >= 0 && node.PaletteIndex < activePalettes.length) {
                            const palette = activePalettes[node.PaletteIndex];
                            if (palette.DataOffset >= 0) {
                                F3DEX2.runDL_F3DEX2(state, fragmentBase + palette.DataOffset);
                            }
                        }
                        const applyTexture = (textureIndex: number): void => {
                            if (textureIndex < 0 || textureIndex >= activeResources.length) return;
                            const texture = activeResources[textureIndex];
                            if (texture.DataOffset >= 0) {
                                state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
                                state.gDPSetTextureImage(texture.Format, texture.Size, texture.Width, fragmentBase + texture.DataOffset);
                            }
                        };
                        if (node.TextureIndex < 0)
                            // func_80015684 / func_80015AC4 disable sampling but
                            // preserve the unit texture scale. Geometry can
                            // preload vertices into the RSP cache while the
                            // texture is off, then reuse them under a textured
                            // sibling (Charizard's torso-to-neck seam does).
                            state.gSPTexture(false, 0, 0, 0xFFFF, 0xFFFF);
                        if (node.DisplayList < 0) return;
                        const runMaterialList = (): void => {
                            F3DEX2.runDL_F3DEX2(state, fragmentBase + node.DisplayList);
                        };
                        const variants: number[][] = [];
                        if (node.MaterialAnimationChannel >= 0) {
                            for (let textureIndex = 0; textureIndex < activeResources.length; textureIndex++) {
                                applyTexture(textureIndex);
                                runMaterialList();
                                variants[textureIndex] = state.getCurrentTextureIndices();
                            }
                        }
                        applyTexture(node.TextureIndex);
                        runMaterialList();
                        state.setMaterialAnimationChannel(node.MaterialAnimationChannel);
                        state.setTextureVariants(variants);
                        if (node.DrawCallbackSemantic === 'UpdateSmeargleMaterialTextureVariantCallback') {
                            const indices = node.DrawCallbackData?.selected_texture_indices;
                            if (!Array.isArray(indices) || !indices.every((index) => typeof index === 'number'))
                                throw new Error('Smeargle material callback has no validated texture-index mapping');
                            state.setMaterialAnimationChannel(-1);
                            state.setPokemonStadiumGsMaterialVariantTextureIndices(indices as number[]);
                        }
                    };
                    applyMaterial();
                    state.commitMaterialState();
                } else if (node.Command === 0x1E || node.Command === 0x20 || node.Command === 0x21 || node.Command === 0x22) {
                    const drawMatrix = node.Command === 0x1E && node.MatrixSlot >= 0
                        ? activeMatrixSlots[node.MatrixSlot] ?? matrix : matrix;
                    runGeometry(node.DisplayList, drawMatrix, node.Layer, this.decalNodes.has(index), activeBillboard,
                        node.DrawCallback, node.DrawCallbackArgument, node.DrawCallbackSemantic, node.DrawCallbackData,
                        node.Parent < 0 ? null : this.modelPose.nodeMatrices[node.Parent]);
                }
                for (const child of this.modelPose.geoChildren[index])
                    walk(child, activeResources, activePalettes, activeBillboard);
                if (node.Command === 0x1D && node.MatrixSlot >= 0)
                    activeMatrixSlots[node.MatrixSlot] = previousSlotMatrix;
                restoreCallbackState?.();
            };
            for (const root of this.modelPose.geoRoots) walk(root, [], [], 0);
        };
        runLayout(this.geoNodes);

        const animationVisibilityByMatrix = new Map<number, { animation: number; start: number; end: number; invert: boolean }>();
        for (let callbackIndex = 0; callbackIndex < this.geoNodes.length; callbackIndex++) {
            const callback = this.geoNodes[callbackIndex];
            const showDuringRange = callback.DrawCallbackSemantic === 'ShowNodeDuringAnimationFrameRangeCallback';
            const hideDuringRange = callback.DrawCallbackSemantic === 'HideNodeDuringAnimationFrameRangeCallback';
            if (callback.DrawCallback !== pokemonDrawCallback.AnimationVisibility &&
                callback.DrawCallback !== pokemonDrawCallback.InvertedAnimationVisibility &&
                !showDuringRange && !hideDuringRange || callback.DrawCallbackArgument < 0) continue;
            const siblings = callback.Parent < 0 ? this.modelPose.geoRoots : this.modelPose.geoChildren[callback.Parent];
            const siblingPosition = siblings.indexOf(callbackIndex);
            if (siblingPosition < 0 || siblings.length < 2) continue;
            // GraphNode.unk_04 is the next sibling in its circular list. These callbacks
            // are authored last, so it wraps to the first sibling that they control.
            const target = siblings[(siblingPosition + 1) % siblings.length];
            const rule = {
                animation: this.dataView.getUint16(callback.DrawCallbackArgument),
                start: this.dataView.getUint16(callback.DrawCallbackArgument + 2),
                end: this.dataView.getUint16(callback.DrawCallbackArgument + 4),
                invert: callback.DrawCallback === pokemonDrawCallback.InvertedAnimationVisibility || hideDuringRange,
            };
            const markSubtree = (index: number): void => {
                animationVisibilityByMatrix.set(matrixIndex(this.modelPose.nodeMatrices[index]), rule);
                for (const child of this.modelPose.geoChildren[index]) markSubtree(child);
            };
            markSubtree(target);
        }

        this.renderData = new RenderData(device, this.renderHelper.renderCache, sharedOutput);
        const output = state.finish();
        if (this.isPokemon && sharedOutput.vertices.length !== 0) {
            const minimum = vec3.fromValues(Infinity, Infinity, Infinity);
            const maximum = vec3.fromValues(-Infinity, -Infinity, -Infinity);
            const position = vec3.create();
            for (const vertex of sharedOutput.vertices) {
                vec3.set(position, vertex.x, vertex.y, vertex.z);
                vec3.transformMat4(position, position, drawMatrices[vertex.matrixIndex] ?? this.modelMatrix);
                vec3.min(minimum, minimum, position);
                vec3.max(maximum, maximum, position);
            }
            vec3.add(this.modelCenter, minimum, maximum);
            vec3.scale(this.modelCenter, this.modelCenter, 0.5);
            vec3.sub(this.modelSize, maximum, minimum);
            this.modelRadius = Math.max(20, vec3.distance(minimum, maximum) * 0.5);
        }
        let stadiumOrder = 0;
        if (output !== null) {
            for (const drawCall of output.drawCalls) {
                // Some stadium setup lists end a queue without emitting any
                // triangles. They carry useful RSP state but are not draws.
                if (drawCall.indexCount === 0) continue;
                const instance = new DrawCallInstance(this.renderData, drawCall, drawMatrices, drawCall.stadiumBillboard, drawCall.stadiumLayer, stadiumOrder++, true);
                const vertexIndex = sharedOutput.indices[drawCall.firstIndex];
                const drawMatrixIndex = sharedOutput.vertices[vertexIndex].matrixIndex;
                const visibility = animationVisibilityByMatrix.get(drawMatrixIndex);
                if (visibility !== undefined) {
                    instance.animationVisibility = visibility;
                    this.animationVisibilityDraws.push(instance);
                }
                if (instance.usesPokemonStadiumGsSelectedTextureAnimation())
                    this.stadiumGsSelectedTextureDraws.push(instance);
                if (instance.usesPokemonStadiumGsMaterialTextureVariants())
                    this.stadiumGsMaterialTextureVariantDraws.push(instance);
                if (stageColorMatrixIndices.has(drawMatrixIndex))
                    this.stadiumGsStageColorDraws.push(instance);
                if (drawCall.stadiumGsModelParticleIndex >= 0) {
                    const group = this.pokemonModelParticleGroups[drawCall.stadiumGsModelParticleGroupIndex];
                    if (group === undefined) throw new Error('model-particle draw has no runtime group');
                    group.draws[drawCall.stadiumGsModelParticleIndex].push(instance);
                    instance.visible = false;
                }
                // Pokémon meshes use cutout textures extensively and need to
                // participate in occlusion. Stadium queues already encode
                // their own Z_UPD state; forcing it here breaks ZMODE_DEC by
                // making successive coplanar markings write over one another.
                if (this.isPokemon) instance.setDepthWriteEnabled(true);
                this.drawCalls.push(instance);
            }
        }
        this.moveEffectPreview = new MoveEffectPreviewRenderer(device, this.moveEffectArchive, battleScale,
            this.renderHelper, this.moveEffectResolver);
        this.selectMoveEffect(null);
    }

    private selectMoveEffect(moveID: number | null): void {
        const attachments = moveID === null ? [] : this.moveEffectAttachmentIDs[moveID - 1] ?? [];
        this.moveEffectPreview.select(moveID, this.moveEffectPreviewSide, attachments);
    }

    private getDisplayListPlaneY(offset: number): number | null {
        let vertexCount = 0;
        let planeY: number | null = null;
        for (let commandOffset = offset; commandOffset + 8 <= this.dataView.byteLength; commandOffset += 8) {
            const word0 = this.dataView.getUint32(commandOffset);
            const opcode = word0 >>> 24;
            if (opcode === 0xDF) break;
            if (opcode !== 0x01) continue;
            const count = word0 >>> 12 & 0xFF;
            const vertexOffset = this.dataView.getUint32(commandOffset + 4) & 0x000FFFFF;
            if (vertexOffset + count * 0x10 > this.dataView.byteLength) return null;
            for (let i = 0; i < count; i++) {
                const y = this.dataView.getInt16(vertexOffset + i * 0x10 + 2);
                if (planeY === null) planeY = y;
                else if (y !== planeY) return null;
                vertexCount++;
            }
        }
        return vertexCount >= 3 ? planeY : null;
    }

    private findVisibleAttackerMoveForAnimation(animationID: number): number {
        return this.animationController.findVisibleAttackerMove(animationID);
    }

    private selectAnimation(time: number): SelectedPokemonAnimation | null {
        return this.animationController.select(time, this.selectedMove);
    }

    private synchronizeMoveEffectToAnimation(selected: ReturnType<PokemonStadiumRenderer['selectAnimation']>): void {
        if (selected === null) {
            this.battleTextRenderer?.update(-1);
            return;
        }
        let side: MoveEffectPreviewSide | null = null;
        let moveID = -1;
        // A pose is shared by many moves. Select the first move assigned to the
        // pose which has an authored attacker visual; choosing the first table
        // entry blindly commonly selected a sound/camera-only primitive.
        const mappedMove = this.selectedMove > 0 ? this.selectedMove : this.findVisibleAttackerMoveForAnimation(selected.index);
        if (mappedMove >= 0) {
            // A move's projectile/elemental body is often authored in the
            // target-action script even when it visibly travels from the user.
            // A single-model exhibit therefore needs the complete move.
            side = this.selectedMoveEffectPreviewSide;
            moveID = mappedMove;
        } else if (this.reactionAnimationIDs.has(selected.index)) {
            // Stable pseudo-random choice among moves which actually define a
            // target reaction, so revisiting a clip does not flicker effects.
            const start = this.legalMoveIDs.length === 0 ? 0 :
                (selected.index * 73 + this.animations.length * 19) % this.legalMoveIDs.length;
            for (let i = 0; i < this.legalMoveIDs.length; i++) {
                const candidate = this.legalMoveIDs[(start + i) % this.legalMoveIDs.length];
                if (this.moveEffectResolver.resolve(candidate).TargetAction.length !== 0) { moveID = candidate; break; }
            }
            if (moveID >= 0) side = 'target';
        }
        const key = side === null ? `none:${selected.index}` : `${side}:${moveID}:${selected.index}`;
        if (key !== this.activeAnimationEffectKey) {
            this.activeAnimationEffectKey = key;
            if (!this.moveEffectsEnabled || side === null) this.selectMoveEffect(null);
            else {
                this.moveEffectPreviewSide = side;
                this.selectMoveEffect(moveID);
            }
        }
        const moveName = moveID > 0 ? this.battleText?.MoveNames[moveID - 1] : undefined;
        this.activeEffectDescription = side === null ? `Animation ${selected.index} — no move effect` :
            `Animation ${selected.index} + ${moveName || `Move ${moveID}`} [${moveID}]`;
        if (this.moveEffectStatus !== null) this.moveEffectStatus.textContent = this.activeEffectDescription;
        this.battleTextRenderer?.update(side === 'attacker' || side === 'both' ? moveID : -1);
        // Byte four of the species' per-move animation record is the frame at
        // which the battle controller invokes the move-effect action. Keep the
        // effect dormant before that contact/event frame, and do not wrap its
        // completed lifecycle while the pose remains active.
        const effectStartFrame = moveID > 0 ? this.moveEffectStartFrames[moveID - 1] ?? 0 : 0;
        // The battle controller initializes its animation counter to zero and
        // dispatches the effect when counter == triggerByte + 1.
        this.animationEffectFrame = selected.elapsed - (effectStartFrame + 1);
    }

    private updateMaterialAnimation(time: number): void {
        const skeletal = this.selectAnimation(time);
        const paired = skeletal === null ? null : this.materialAnimationBySkeletalIndex[skeletal.index];
        const selected = paired !== null && paired !== undefined
            ? { animation: paired, frame: Math.min(skeletal!.frame, paired.FrameCount - 1) }
            : null;
        if (selected === null) return;
        const textureIndices: number[] = [];
        for (let channel = 0; channel < selected.animation.Channels.length; channel++) {
            const range = selected.animation.Channels[channel];
            const index = range.FirstTextureIndex + Math.min(selected.frame, range.FrameCount - 1);
            textureIndices[channel] = this.dataView.getUint8(selected.animation.TextureIndicesOffset + index);
        }
        for (const drawCall of this.drawCalls) drawCall.applyStadiumMaterialAnimation(textureIndices);
    }

    public adjustCameraController(controller: CameraController): void {
        controller.setSceneMoveSpeedMult(0.02);
    }

    public createPanels(): UI.Panel[] {
        const panel = new UI.Panel();
        panel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        panel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');
        if (this.battleText !== undefined) {
            const battleText = new UI.Checkbox('Enable Battle Text', true);
            battleText.onchanged = () => this.battleTextRenderer?.setEnabled(battleText.checked);
            panel.contents.appendChild(battleText.elem);
        }
        this.moveEffectStatus = document.createElement('div');
        this.moveEffectStatus.style.padding = '4px 8px';
        this.moveEffectStatus.style.opacity = '0.85';
        this.moveEffectStatus.textContent = this.activeEffectDescription;
        panel.contents.appendChild(this.moveEffectStatus);
        const enabled = new UI.Checkbox('Enable Move Effects', this.moveEffectsEnabled);
        enabled.onchanged = () => {
            this.moveEffectsEnabled = enabled.checked;
            this.activeAnimationEffectKey = '';
            this.selectMoveEffect(this.moveEffectsEnabled && this.selectedMove > 0 ? this.selectedMove : null);
        };
        panel.contents.appendChild(enabled.elem);
        const side = new UI.RadioButtons('Preview Side', ['Attacker', 'Target', 'Both']);
        side.setSelectedIndex(0);
        side.onselectedchange = () => {
            this.selectedMoveEffectPreviewSide = side.selectedIndex === 0 ? 'attacker' : side.selectedIndex === 1 ? 'target' : 'both';
            this.moveEffectPreviewSide = this.selectedMoveEffectPreviewSide;
            if (this.moveEffectsEnabled && this.selectedMove > 0) this.selectMoveEffect(this.selectedMove);
        };
        panel.contents.appendChild(side.elem);
        const move = new UI.Slider('Move (0 = Auto)', 0, 0, this.legalMoveIDs.length);
        this.moveSelect = move;
        move.setRange(0, this.legalMoveIDs.length, 1);
        const updateMoveLabel = (selectionIndex: number): void => {
            const moveID = selectionIndex === 0 ? 0 : this.legalMoveIDs[selectionIndex - 1];
            move.setLabel(moveID === 0 ? `Move (0 = Auto; ${this.legalMoveIDs.length} legal)` :
                `Move: ${this.battleText?.MoveNames[moveID - 1] ?? 'Unknown'} [${moveID}]`);
        };
        updateMoveLabel(0);
        move.onvalue = (value: number) => {
            const selectionIndex = Math.round(value);
            this.selectedMove = selectionIndex === 0 ? 0 : this.legalMoveIDs[selectionIndex - 1];
            updateMoveLabel(selectionIndex);
            this.activeAnimationEffectKey = '';
            this.animationTimeOrigin = null;
            // Resolve eagerly so missing attachment banks or lifecycle entries
            // fail at selection time rather than during rendering.
            if (this.moveEffectsEnabled) this.selectMoveEffect(this.selectedMove > 0 ? this.selectedMove : null);
            this.onstatechanged();
        };
        panel.contents.appendChild(move.elem);
        if (this.stadiumGsMaterialTextureVariantCount > 1) {
            const coatVariant = new UI.Slider(
                'Smeargle Coat Variant', 0, 0, this.stadiumGsMaterialTextureVariantCount - 1,
            );
            coatVariant.setRange(0, this.stadiumGsMaterialTextureVariantCount - 1, 1);
            coatVariant.onvalue = (value: number) => {
                this.stadiumGsMaterialTextureVariant = Math.round(value);
                this.onstatechanged();
            };
            panel.contents.appendChild(coatVariant.elem);
        }
        this.battleTextRenderer?.mount();
        return [panel];
    }

    public serializeSaveState(dst: ArrayBuffer, offs: number): number {
        new DataView(dst).setUint8(offs++, this.selectedMove);
        return offs;
    }

    public deserializeSaveState(src: ArrayBufferSlice): void {
        if (src.byteLength === 0) return;
        const moveID = src.createDataView().getUint8(0);
        this.selectedMove = moveID === 0 || this.legalMoveIDs.includes(moveID) ? moveID : 0;
        const selectionIndex = this.selectedMove === 0 ? 0 : this.legalMoveIDs.indexOf(this.selectedMove) + 1;
        this.moveSelect?.setValue(selectionIndex, true);
        this.activeAnimationEffectKey = '';
        this.animationTimeOrigin = null;
        if (this.moveEffectsEnabled) this.selectMoveEffect(this.selectedMove > 0 ? this.selectedMove : null);
    }

    public getDefaultWorldMatrix(dst: mat4): void {
        if (this.isPokemon) {
            // Stadium's attacker cameras orbit their subject using binary-angle
            // azimuths. Use a stable -0x1000 (-22.5 degree) attacker-side view
            // here instead of the battle code's randomized attack-camera swing.
            const attackerViewAzimuth = -Math.PI / 8;
            const distance = this.modelRadius * 3.5;
            mat4.targetTo(dst,
                [this.modelCenter[0] + Math.sin(attackerViewAzimuth) * distance,
                    this.modelCenter[1] + this.modelRadius * 0.15,
                    this.modelCenter[2] + Math.cos(attackerViewAzimuth) * distance],
                this.modelCenter, [0, 1, 0]);
        } else {
            mat4.targetTo(dst, [0, 1000, 1000], [0, 100, 0], [0, 1, 0]);
        }
    }

    /** Set the battle runtime's global RGBA8 stage override in normalized form. */
    public setPokemonStadiumGsStageColor(color: readonly [number, number, number, number]): void {
        this.stadiumGsStageColor = color;
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        if (this.animationTimeOrigin === null) this.animationTimeOrigin = viewerInput.time;
        const animationTime = Math.max(0, viewerInput.time - this.animationTimeOrigin);
        const animationViewerInput = { ...viewerInput, time: animationTime };
        const selectedAnimation = this.selectAnimation(animationTime);
        this.modelPose.update(selectedAnimation);
        this.updateMaterialAnimation(animationTime);
        for (const drawCall of this.animationVisibilityDraws) {
            const rule = drawCall.animationVisibility!;
            const inRange = selectedAnimation !== null && selectedAnimation.index === rule.animation &&
                selectedAnimation.frame >= rule.start && selectedAnimation.frame <= rule.end;
            drawCall.visible = rule.invert ? !inRange : inRange;
        }
        // BuildBattleStateSelectedRgba16TextureDisplayList is used only by
        // resource/species 88. It advances frames during physical animation
        // slots 0/1 from skeletal frame 66 through 73, and otherwise selects
        // the first texture.
        const selectedTextureFrame = selectedAnimation !== null && selectedAnimation.index <= 1 &&
            selectedAnimation.frame >= 66 && selectedAnimation.frame < 74
            ? Math.floor(selectedAnimation.frame) - 66 : 0;
        for (const drawCall of this.stadiumGsSelectedTextureDraws)
            drawCall.setStadiumTextureVariant(selectedTextureFrame);
        for (const drawCall of this.stadiumGsMaterialTextureVariantDraws)
            drawCall.setPokemonStadiumGsMaterialTextureVariant(this.stadiumGsMaterialTextureVariant);
        for (const drawCall of this.stadiumGsStageColorDraws)
            drawCall.setModelTint(this.stadiumGsStageColor);
        const generatedRibbonFrame = Math.floor(animationTime * 30 / 1000);
        for (const ribbon of this.generatedRibbonInstances) {
            if (generatedRibbonFrame < ribbon.lastFrame) {
                ribbon.state = initializeGeneratedRibbon(ribbon.template);
                ribbon.lastFrame = -1;
            }
            while (ribbon.lastFrame < generatedRibbonFrame) {
                stepGeneratedRibbon(ribbon.template, ribbon.state);
                ribbon.lastFrame++;
            }
            for (let index = 0; index < ribbon.vertexMatrices.length; index++) {
                const source = ribbon.state.vertices[index].sourcePosition;
                const position = ribbon.state.vertices[index].position;
                mat4.translate(ribbon.vertexMatrices[index], ribbon.baseMatrix, [
                    position[0] - source[0], position[1] - source[1], position[2] - source[2],
                ]);
            }
        }
        const modelParticleFrame = Math.floor(animationTime * 30 / 1000);
        const particleRuntime = this.pokemonModelParticleGroups[0];
        if (particleRuntime !== undefined) {
            if (modelParticleFrame < particleRuntime.lastFrame) {
                particleRuntime.simulator.reset();
                particleRuntime.lastFrame = -1;
                particleRuntime.randomState = particleRuntime.randomInitialState;
            }
            const matrixContext = (emitter: typeof particleRuntime) => {
                const modelScale = vec3.create(), origin = vec3.create(), direction = vec3.create();
                mat4.getScaling(modelScale, emitter.baseMatrix);
                mat4.getTranslation(origin, emitter.baseMatrix);
                if (emitter.parentMatrix !== null) mat4.getTranslation(direction, emitter.parentMatrix);
                else vec3.set(direction, origin[0], origin[1] + 1, origin[2]);
                vec3.sub(direction, direction, origin);
                if (vec3.squaredLength(direction) > 0) vec3.normalize(direction, direction);
                else vec3.set(direction, 0, 1, 0);
                return { modelScale, origin, direction };
            };
            while (particleRuntime.lastFrame < modelParticleFrame) {
                for (const emitter of this.pokemonModelParticleGroups) {
                    const context = matrixContext(emitter);
                    particleRuntime.simulator.scheduleSpawn({
                        origin: [context.origin[0], context.origin[1], context.origin[2]],
                        direction: [context.direction[0], context.direction[1], context.direction[2]],
                        modelScale: [context.modelScale[0], context.modelScale[1], context.modelScale[2]],
                        randomInt: () => {
                            particleRuntime.randomState = nextPokemonStadiumGsRandom(particleRuntime.randomState);
                            return particleRuntime.randomState | 0;
                        },
                        animationScheduleState: selectedAnimation === null ? undefined : {
                            callbackOrdinal: emitter.callbackOrdinal,
                            animationIndex: selectedAnimation.index,
                            animationFrame: Math.floor(selectedAnimation.frame),
                        },
                    });
                    // Only callback ordinal zero builds/renders the shared pool,
                    // and therefore it is the sole per-frame update site.
                    if (emitter.callbackOrdinal === 0)
                        particleRuntime.simulator.update([
                            context.modelScale[0], context.modelScale[1], context.modelScale[2],
                        ]);
                }
                particleRuntime.lastFrame++;
            }
            const renderContext = matrixContext(particleRuntime);
            for (let index = 0; index < particleRuntime.simulator.particles.length; index++) {
                const particle = particleRuntime.simulator.particles[index];
                // Species 92's render branch refreshes translation from matrix
                // stack entry zero each draw instead of using record +0x04.
                const renderPosition = particleRuntime.simulator.speciesID === 92
                    ? renderContext.origin : particle.position;
                mat4.fromTranslation(particleRuntime.matrices[index], renderPosition);
                mat4.scale(particleRuntime.matrices[index], particleRuntime.matrices[index], [
                    renderContext.modelScale[0] * particle.scale[0] * 0.1,
                    renderContext.modelScale[1] * particle.scale[1] * 0.1,
                    renderContext.modelScale[2] * particle.scale[2] * 0.1,
                ]);
                for (const draw of particleRuntime.draws[index]) {
                    draw.visible = particle.active;
                    if (!particle.active) continue;
                    draw.setStadiumTextureVariant(Math.min(7, particle.frame >> 1));
                    draw.setCombineColors([10 / 255, 0, 0, Math.max(0, 200 - particle.frame * 13) / 255]);
                }
            }
        }
        this.synchronizeMoveEffectToAnimation(selectedAnimation);
        this.moveEffectPreview.applyModelEffects(this.drawCalls, this.isPokemon, this.animationEffectFrame);

        const manager = this.renderHelper.renderInstManager;
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        template.setVertexInput(this.renderData.inputLayout, this.renderData.vertexBufferDescriptors,
            this.renderData.indexBufferDescriptor);
        let offs = template.allocateUniformBuffer(F3DEX_Program.ub_SceneParams, 24);
        const mapped = template.mapUniformBufferF32(F3DEX_Program.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, viewerInput.camera.projectionMatrix);
        computeViewMatrix(viewMatrixScratch, viewerInput.camera);
        mat4.getTranslation(lookatScratch, this.modelMatrix);
        vec3.transformMat4(lookatScratch, lookatScratch, viewMatrixScratch);
        mat4.lookAt(lookatMatrixScratch, [0, 0, 0], lookatScratch, [0, 1, 0]);
        offs += fillVec4(mapped, offs, lookatMatrixScratch[0], lookatMatrixScratch[4], lookatMatrixScratch[8]);
        fillVec4(mapped, offs, lookatMatrixScratch[1], lookatMatrixScratch[5], lookatMatrixScratch[9]);
        manager.setCurrentList(this.renderInstList);
        for (const drawCall of this.drawCalls)
            drawCall.prepareToRender(device, manager, animationViewerInput, false);
        // RenderPokemonModelToCaptureTexture traverses the live actor a second
        // time after selecting a 32x32 color/depth descriptor pair. Keep that
        // traversal in a separate list so move effects never feed back into
        // their own current-Pokemon texture.
        if (this.isPokemon) {
            manager.setCurrentList(this.pokemonCaptureRenderInstList);
            for (const drawCall of this.drawCalls)
                drawCall.prepareToRender(device, manager, animationViewerInput, false);
            manager.setCurrentList(this.renderInstList);
        }
        manager.popTemplate();

        this.moveEffectPreview.setCurrentPokemonCaptureTexture(this.pokemonCaptureColor);
        this.moveEffectPreview.prepareToRender(animationViewerInput, this.animationEffectFrame, this.modelPose,
            this.modelMatrix, this.modelSize, viewMatrixScratch);
        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        if (this.isPokemon) builder.pushPass((pass) => {
            pass.setDebugName('Current Pokemon 32x32 Capture');
            // The original clear value is RGBA16 0x4a53: (9,9,9,1) in RGBA5551.
            const clear = makeAttachmentClearDescriptor(colorNewFromRGBA(9 / 31, 9 / 31, 9 / 31, 1));
            pass.attachTexture(GfxrAttachmentSlot.Color0, this.pokemonCaptureColor, undefined, clear);
            pass.attachTexture(GfxrAttachmentSlot.DepthStencil, this.pokemonCaptureDepth, undefined, clear);
            pass.exec((renderer) => this.pokemonCaptureRenderInstList.drawOnPassRenderer(this.renderHelper.renderCache, renderer));
        });
        const color = builder.createRenderTargetID(makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, this.clearPass), 'Main Color');
        const depth = builder.createRenderTargetID(makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, this.clearPass), 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, color);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, depth);
            pass.exec((renderer) => this.renderInstList.drawOnPassRenderer(this.renderHelper.renderCache, renderer));
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, color);
        builder.resolveRenderTargetToExternalTexture(color, viewerInput.onscreenTexture);
        this.prepareToRender(device, viewerInput);
        builder.execute();
        this.renderInstList.reset();
        this.pokemonCaptureRenderInstList.reset();
    }

    public destroy(device: GfxDevice): void {
        this.battleTextRenderer?.destroy();
        this.renderData.destroy(device);
        this.moveEffectPreview.destroy();
        device.destroyTexture(this.pokemonCaptureColor);
        device.destroyTexture(this.pokemonCaptureDepth);
        this.renderHelper.destroy();
    }
}
