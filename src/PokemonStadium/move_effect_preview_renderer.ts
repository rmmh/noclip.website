import { mat4, vec3 } from 'gl-matrix';
import { F3DEX_Program } from '../BanjoKazooie/render.js';
import { fillMatrix4x4, fillVec4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { copyMegaState, fullscreenMegaState, setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers.js';
import {
    GfxBindingLayoutDescriptor, GfxBlendFactor, GfxBlendMode, GfxDevice, GfxProgram, GfxTexture,
} from '../gfx/platform/GfxPlatform.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import * as Viewer from '../viewer.js';
import {
    MoveEffectArchive, MoveEffectModelTint, MoveEffectParticleSpawn, MoveEffectPrimitive, MoveEffectResolver,
    moveEffectColorPairs, moveEffectColors,
} from './effects.js';
import {
    cyclingModelTintUpdate, modelOpacityFadeUpdate, moveEffectScreenFlashUpdates,
} from './draw_callbacks.js';
import { MoveEffectScreenFlashProgram } from './materials.js';
import { moveEffectPreviewFrames, PointTrailKind, WaveGridKind } from './move_effect_geometry.js';
import {
    MoveEffectAssets, MoveEffectPreviewSide, NeedleProjectileKind, PlantParticleKind, SpiralRibbonPalette,
} from './move_effect_renderer.js';
import { getMoveEffectParticleOrigin } from './move_effect_origin.js';
import { MoveEffectSimulator } from './move_effect_simulator.js';
import { moveEffectEmissionCount, moveEffectFirstEmissionFrame } from './move_effect_timing.js';
import { PokemonModelPose } from './model_pose.js';
import { DrawCallInstance } from './render.js';

const bindingLayouts: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 4, numSamplers: 2 }];
const screenFlashBindingLayouts: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 0 }];
const screenFlashMegaState = copyMegaState(fullscreenMegaState);
setAttachmentStateSimple(screenFlashMegaState, {
    blendMode: GfxBlendMode.Add,
    blendSrcFactor: GfxBlendFactor.SrcAlpha,
    blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
});

interface SpawnRecord {
    Spawn: MoveEffectParticleSpawn;
    Target: boolean;
    Result: boolean;
}

interface ActiveCustomEffects {
    RingArchive: number;
    RingModes: number;
    SpiralRibbonPalette: SpiralRibbonPalette | null;
    WaveGridKind: WaveGridKind | null;
    WaveGridArchive: number;
    PointTrailKind: PointTrailKind | null;
    ReturningRibbonArchive: number;
    NeedleProjectileKind: NeedleProjectileKind | null;
    PlantParticleKind: PlantParticleKind | null;
    PlantParticleArchive: number;
    SwiftArchive: number;
}

function emptyCustomEffects(): ActiveCustomEffects {
    return {
        RingArchive: -1, RingModes: 0, SpiralRibbonPalette: null, WaveGridKind: null, WaveGridArchive: -1,
        PointTrailKind: null, ReturningRibbonArchive: -1, NeedleProjectileKind: null, PlantParticleKind: null,
        PlantParticleArchive: -1, SwiftArchive: -1,
    };
}

function moveEffectAngle(angle: number): number {
    return (angle & 0xFFFF) * Math.PI * 2 / 0x10000;
}

function hasLifecycle(primitives: readonly MoveEffectPrimitive[], lifecycle: NonNullable<MoveEffectPrimitive['CustomLifecycle']>): boolean {
    return primitives.some((primitive) => primitive.CustomLifecycle === lifecycle);
}

export class MoveEffectPreviewRenderer {
    private resolver: MoveEffectResolver;
    private simulator: MoveEffectSimulator;
    private assets: MoveEffectAssets;
    private screenFlashProgram: GfxProgram;
    private activeMoveID = -1;
    private custom = emptyCustomEffects();
    private screenFlashSpawns: MoveEffectParticleSpawn[] = [];
    private modelTints: { Tint: MoveEffectModelTint; Target: boolean }[] = [];
    private modelParticleResources = new Map<string, SpawnRecord[]>();
    private particleOrigin = vec3.create();
    private customOrigin = vec3.create();
    private returningOrigin = vec3.create();
    private particleMatrix = mat4.create();
    private cameraWorld = mat4.create();
    private screenProjection = mat4.ortho(mat4.create(), 0, 320, 0, 240, -1, 1);

    constructor(private device: GfxDevice, private archive: MoveEffectArchive, battleScale: number,
                private renderHelper: GfxRenderHelper, resolver?: MoveEffectResolver) {
        this.resolver = resolver ?? new MoveEffectResolver(archive);
        this.simulator = new MoveEffectSimulator(archive.Data);
        this.assets = new MoveEffectAssets(archive, battleScale, renderHelper);
        this.screenFlashProgram = renderHelper.renderCache.createProgram(new MoveEffectScreenFlashProgram());
        this.select(null, 'attacker', []);
    }

    public setCurrentPokemonCaptureTexture(texture: GfxTexture): void {
        this.assets.setCurrentPokemonCaptureTexture(texture);
    }

    public select(moveID: number | null, side: MoveEffectPreviewSide, attackerAttachmentIDs: readonly number[]): void {
        this.simulator.clear();
        this.assets.effectSpriteDraws.length = 0;
        this.activeMoveID = moveID ?? -1;
        this.custom = emptyCustomEffects();
        this.screenFlashSpawns = [];
        this.modelTints = [];
        this.modelParticleResources.clear();
        if (moveID === null) {
            this.assets.selectStandardEffects(this.device, [], new Set());
            this.assets.selectCustomEffects(this.device, null);
            return;
        }

        const resolved = this.resolver.resolve(moveID);
        const includeAttacker = side !== 'target';
        const includeTarget = side !== 'attacker';
        const attackerPrimitives = includeAttacker ? [...resolved.AttackerSetup, ...resolved.AttackerAction] : [];
        const resultPrimitives = includeAttacker ? resolved.ResultAction : [];
        const targetPrimitives = includeTarget ? resolved.TargetAction : [];
        const bindAttackerSpawn = (spawn: MoveEffectParticleSpawn): MoveEffectParticleSpawn[] => {
            if (spawn.InitialState.CD >= 0 || attackerAttachmentIDs.length === 0) return [spawn];
            return attackerAttachmentIDs.map((attachmentID) => ({
                ...spawn,
                Arguments: spawn.Arguments.map((value, index) => index === 3 ? attachmentID : value),
                InitialState: { ...spawn.InitialState, CD: attachmentID },
            }));
        };
        const spawns: SpawnRecord[] = [
            ...attackerPrimitives.flatMap((primitive) => primitive.ParticleSpawns.flatMap((spawn) =>
                bindAttackerSpawn(spawn).map((Spawn) => ({ Spawn, Target: false, Result: false })))),
            ...resultPrimitives.flatMap((primitive) => primitive.ParticleSpawns.flatMap((spawn) =>
                bindAttackerSpawn(spawn).map((Spawn) => ({ Spawn, Target: false, Result: true })))),
            ...targetPrimitives.flatMap((primitive) => primitive.ParticleSpawns.map((Spawn) =>
                ({ Spawn, Target: true, Result: false }))),
        ];
        const activeResourceKeys = new Set([...resolved.Resources.values(), ...resolved.ResultResources.values()]
            .map((resource) => `${resource.ArchiveID}:${resource.ResourceID}`));
        this.assets.selectStandardEffects(this.device, spawns.map(({ Spawn }) => Spawn), activeResourceKeys);
        for (const record of spawns) {
            if (record.Spawn.ParticleStyle !== -1) continue;
            for (const pair of record.Spawn.ModelResources) {
                const resources = record.Result ? resolved.ResultResources : resolved.Resources;
                const model = resources.get(pair.ModelResourceID);
                if (model === undefined) continue;
                const key = `${model.ArchiveID}:${pair.ModelResourceID}:${pair.AnimationResourceID}`;
                let records = this.modelParticleResources.get(key);
                if (records === undefined) this.modelParticleResources.set(key, records = []);
                records.push(record);
            }
        }

        const customPrimitives = [...attackerPrimitives, ...resultPrimitives, ...targetPrimitives];
        this.custom.RingModes = hasLifecycle(customPrimitives, 'hazeRings') ? 3 :
            hasLifecycle(customPrimitives, 'mistRing') ? 1 : 0;
        this.custom.RingArchive = this.custom.RingModes === 0 ? -1 : resolved.Resources.get(0x43)?.ArchiveID ?? -1;
        this.custom.SpiralRibbonPalette = hasLifecycle(customPrimitives, 'cyanSpiralRibbon') ? 'cyan' :
            hasLifecycle(customPrimitives, 'whiteSpiralRibbon') ? 'white' :
                hasLifecycle(customPrimitives, 'yellowSpiralRibbon') ? 'yellow' : null;
        this.custom.WaveGridKind = hasLifecycle(customPrimitives, 'radialWaveGrid') ? 'radialWaveGrid' :
            hasLifecycle(customPrimitives, 'randomWaveGrid') ? 'randomWaveGrid' :
                hasLifecycle(customPrimitives, 'subtleWaveGrid') ? 'subtleWaveGrid' : null;
        const waveResourceID = this.custom.WaveGridKind === 'radialWaveGrid' ? 0xA8 : 0x48;
        this.custom.WaveGridArchive = this.custom.WaveGridKind === null ? -1 :
            resolved.Resources.get(waveResourceID)?.ArchiveID ?? -1;
        this.custom.PointTrailKind = hasLifecycle(customPrimitives, 'cyanPointTrail') ? 'cyanPointTrail' :
            hasLifecycle(customPrimitives, 'whitePointTrail') ? 'whitePointTrail' :
                hasLifecycle(customPrimitives, 'yellowPointTrail') ? 'yellowPointTrail' :
                    hasLifecycle(customPrimitives, 'prismaticPointTrail') ? 'prismaticPointTrail' : null;
        this.custom.ReturningRibbonArchive = hasLifecycle(customPrimitives, 'returningRibbonTrails') ?
            resolved.Resources.get(0x49)?.ArchiveID ?? -1 : -1;
        this.custom.NeedleProjectileKind = hasLifecycle(customPrimitives, 'needleProjectile') ? 'needleProjectile' :
            hasLifecycle(customPrimitives, 'archingNeedleVolley') ? 'archingNeedleVolley' : null;
        this.custom.PlantParticleKind = hasLifecycle(customPrimitives, 'razorLeafPool') ? 'razorLeafPool' :
            hasLifecycle(customPrimitives, 'petalDancePool') ? 'petalDancePool' : null;
        const plantResourceID = this.custom.PlantParticleKind === 'razorLeafPool' ? 0x1C : 0x1E;
        this.custom.PlantParticleArchive = this.custom.PlantParticleKind === null ? -1 :
            resolved.Resources.get(plantResourceID)?.ArchiveID ?? -1;
        this.custom.SwiftArchive = hasLifecycle(customPrimitives, 'swiftStarPool') ?
            resolved.Resources.get(0x10)?.ArchiveID ?? -1 : -1;
        this.assets.selectCustomEffects(this.device, {
            CustomRing: this.custom.RingModes === 0 ? undefined :
                { ArchiveID: this.custom.RingArchive, Modes: this.custom.RingModes },
            SpiralRibbon: this.custom.SpiralRibbonPalette ?? undefined,
            WaveGrid: this.custom.WaveGridKind === null ? undefined :
                { ArchiveID: this.custom.WaveGridArchive, Kind: this.custom.WaveGridKind },
            PointTrail: this.custom.PointTrailKind ?? undefined,
            ReturningRibbonArchive: this.custom.ReturningRibbonArchive < 0 ? undefined : this.custom.ReturningRibbonArchive,
            NeedleProjectile: this.custom.NeedleProjectileKind ?? undefined,
            PlantParticle: this.custom.PlantParticleKind === null ? undefined :
                { ArchiveID: this.custom.PlantParticleArchive, Kind: this.custom.PlantParticleKind },
            SwiftArchive: this.custom.SwiftArchive < 0 ? undefined : this.custom.SwiftArchive,
        });
        this.screenFlashSpawns = spawns.map(({ Spawn }) => Spawn)
            .filter((spawn) => spawn.ParticleStyle === 37 && moveEffectScreenFlashUpdates.has(spawn.UpdateFunction));
        this.modelTints = [
            ...attackerPrimitives.flatMap((primitive) => primitive.ModelTints.map((Tint) => ({ Tint, Target: false }))),
            ...targetPrimitives.flatMap((primitive) => primitive.ModelTints.map((Tint) => ({ Tint, Target: true }))),
        ];
        this.buildSpriteDraws(spawns, resolved.Resources, resolved.ResultResources);
    }

    private buildSpriteDraws(spawns: SpawnRecord[], resources: ReturnType<MoveEffectResolver['resolve']>['Resources'],
                             resultResources: ReturnType<MoveEffectResolver['resolve']>['ResultResources']): void {
        if (this.assets.effectRenderData === null) return;
        for (let sourceIndex = 0; sourceIndex < this.assets.effectSpriteSources.length; sourceIndex++) {
            const source = this.assets.effectSpriteSources[sourceIndex];
            const descriptor = this.archive.MoveEffects.RenderDescriptors[source.DescriptorIndex];
            const sourceSpawns = spawns.filter(({ Spawn, Result }) => {
                const style = this.archive.MoveEffects.ParticleStyles[Spawn.ParticleStyle];
                const activeResource = (Result ? resultResources : resources).get(descriptor.ResourceID);
                return style !== undefined && style.RenderDescriptor === source.DescriptorIndex &&
                    activeResource?.ArchiveID === source.ArchiveID;
            });
            for (const spawnRecord of sourceSpawns) {
                const spawn = spawnRecord.Spawn;
                const pair = moveEffectColorPairs[spawn.PaletteIndices[0] ?? -1];
                const prim = moveEffectColors[spawn.PrimitiveColorIndices[0] ?? pair?.[0]];
                const env = moveEffectColors[spawn.EnvironmentColorIndices[0] ?? pair?.[1]];
                const matrices: mat4[][] = [];
                const drawCalls: DrawCallInstance[] = [];
                for (let textureFrame = 0; textureFrame < descriptor.TextureFrameCount; textureFrame++) {
                    const drawMatrices = Array.from({ length: source.Capacity }, () => mat4.create());
                    const drawCall = new DrawCallInstance(this.assets.effectRenderData, source.GeometryDrawCall, drawMatrices,
                        descriptor.Billboard ? 8 : 0, 5, sourceIndex, false,
                        descriptor.GeometryKind.startsWith('screen320x240'));
                    drawCall.setDepthWriteEnabled(false);
                    drawCall.setStadiumTextureVariant(textureFrame);
                    drawCall.setCombineColors(
                        prim === undefined ? null : [prim[0] / 255, prim[1] / 255, prim[2] / 255, 1],
                        env === undefined ? null : [env[0] / 255, env[1] / 255, env[2] / 255, 1]);
                    matrices.push(drawMatrices);
                    drawCalls.push(drawCall);
                }
                this.assets.effectSpriteDraws.push({ DescriptorIndex: source.DescriptorIndex, ArchiveID: source.ArchiveID,
                    DrawCalls: drawCalls, Matrices: matrices, Spawns: [spawnRecord] });
            }
        }
    }

    public applyModelEffects(drawCalls: readonly DrawCallInstance[], isPokemon: boolean, frame: number): void {
        let modelTint = null as ReturnType<MoveEffectSimulator['simulateModelTint']>[number] | null;
        let modelTintStrength = 0;
        let modelPrimLOD: number | null = null;
        for (const { Tint } of this.modelTints) {
            const age = frame - Tint.Delay;
            if (age < 0) continue;
            const sample = this.simulator.simulateModelTint(Tint, this.activeMoveID)[age];
            if (sample === undefined || !sample.Alive) continue;
            if (Tint.UpdateFunction === modelOpacityFadeUpdate) modelPrimLOD = sample.Alpha / 255;
            else {
                const strength = Tint.UpdateFunction === cyclingModelTintUpdate ? sample.Alpha : sample.ModelTintAmount;
                if (strength > 0) { modelTint = sample; modelTintStrength = strength; }
            }
        }
        for (const drawCall of drawCalls) {
            drawCall.setModelTint(!isPokemon || modelTint === null ? null : [modelTint.PrimitiveColor[0] / 255,
                modelTint.PrimitiveColor[1] / 255, modelTint.PrimitiveColor[2] / 255, modelTintStrength / 255]);
            drawCall.setModelPrimLOD(isPokemon ? modelPrimLOD : null);
        }
    }

    private origin(modelMatrix: mat4, modelSize: vec3, modelPose: PokemonModelPose,
                   spawn: MoveEffectParticleSpawn, target: boolean): vec3 {
        return getMoveEffectParticleOrigin({ ModelMatrix: modelMatrix, ModelSize: modelSize, ModelPose: modelPose },
            spawn, target, this.particleOrigin);
    }

    public prepareToRender(viewerInput: Viewer.ViewerRenderInput, frame: number, modelPose: PokemonModelPose,
                           modelMatrix: mat4, modelSize: vec3, viewMatrix: mat4): void {
        const manager = this.renderHelper.renderInstManager;
        const effectRenderData = this.assets.effectRenderData ?? this.assets.customEffectRenderData;
        if (effectRenderData !== null) {
            if (!modelPose.getAttachmentPosition(0x0A, this.customOrigin) &&
                !modelPose.getAttachmentPosition(0x64, this.customOrigin))
                vec3.set(this.customOrigin, modelMatrix[12], modelMatrix[13], modelMatrix[14]);
            this.updateModelParticles(frame, modelPose, modelMatrix, modelSize);
            this.updateCustomEffects(frame, modelPose, viewerInput, viewMatrix);

            const effectTemplate = this.renderHelper.pushTemplateRenderInst();
            effectTemplate.setBindingLayouts(bindingLayouts);
            effectTemplate.setVertexInput(effectRenderData.inputLayout, effectRenderData.vertexBufferDescriptors,
                effectRenderData.indexBufferDescriptor);
            this.fillSceneUniforms(effectTemplate, viewerInput.camera.projectionMatrix);
            this.updateSpriteParticles(frame, modelPose, modelMatrix, modelSize);
            for (const draw of this.assets.effectSpriteDraws) {
                const descriptor = this.archive.MoveEffects.RenderDescriptors[draw.DescriptorIndex];
                if (!descriptor.GeometryKind.startsWith('screen320x240'))
                    for (const drawCall of draw.DrawCalls) drawCall.prepareToRender(this.device, manager, viewerInput, false);
            }
            for (const draw of this.assets.modelParticleDraws)
                if (draw.DrawCall.visible) draw.DrawCall.prepareToRender(this.device, manager, viewerInput, false);
            manager.popTemplate();

            const customRenderData = this.assets.customEffectRenderData;
            if (customRenderData !== null) {
                const customTemplate = this.renderHelper.pushTemplateRenderInst();
                customTemplate.setBindingLayouts(bindingLayouts);
                customTemplate.setVertexInput(customRenderData.inputLayout, customRenderData.vertexBufferDescriptors,
                    customRenderData.indexBufferDescriptor);
                this.fillSceneUniforms(customTemplate, viewerInput.camera.projectionMatrix);
                for (const draw of this.assets.customEffectDraws)
                    if (draw.DrawCall.visible) draw.DrawCall.prepareToRender(this.device, manager, viewerInput, false);
                manager.popTemplate();
            }

            const screenTemplate = this.renderHelper.pushTemplateRenderInst();
            screenTemplate.setBindingLayouts(bindingLayouts);
            screenTemplate.setVertexInput(effectRenderData.inputLayout, effectRenderData.vertexBufferDescriptors,
                effectRenderData.indexBufferDescriptor);
            this.fillSceneUniforms(screenTemplate, this.screenProjection);
            for (const draw of this.assets.effectSpriteDraws) {
                const descriptor = this.archive.MoveEffects.RenderDescriptors[draw.DescriptorIndex];
                if (descriptor.GeometryKind.startsWith('screen320x240'))
                    for (const drawCall of draw.DrawCalls) drawCall.prepareToRender(this.device, manager, viewerInput, false);
            }
            manager.popTemplate();
        }
        this.prepareScreenFlashes(frame);
    }

    private fillSceneUniforms(template: ReturnType<GfxRenderHelper['pushTemplateRenderInst']>, projection: mat4): void {
        let offs = template.allocateUniformBuffer(F3DEX_Program.ub_SceneParams, 24);
        const mapped = template.mapUniformBufferF32(F3DEX_Program.ub_SceneParams);
        offs += fillMatrix4x4(mapped, offs, projection);
        offs += fillVec4(mapped, offs, 1, 0, 0);
        fillVec4(mapped, offs, 0, 1, 0);
    }

    private updateModelParticles(frame: number, modelPose: PokemonModelPose, modelMatrix: mat4, modelSize: vec3): void {
        for (const draw of this.assets.modelParticleDraws) {
            const records = this.modelParticleResources.get(
                `${draw.ArchiveID}:${draw.ResourceID}:${draw.AnimationResourceID}`) ?? [];
            draw.DrawCall.visible = false;
            for (const record of records) {
                const origin = this.origin(modelMatrix, modelSize, modelPose, record.Spawn, record.Target);
                let rendered = false;
                for (let repetition = 0; repetition < moveEffectEmissionCount(record.Spawn) && !rendered; repetition++) {
                    if (draw.ParticleSlot >= Math.max(1, record.Spawn.BurstCount)) continue;
                    const emissionFrame = moveEffectFirstEmissionFrame(record.Spawn) +
                        repetition * Math.max(1, record.Spawn.Interval);
                    const age = frame - emissionFrame;
                    if (age < 0 || age >= moveEffectPreviewFrames) continue;
                    const state = this.simulator.simulateParticle(
                        record.Spawn, draw.ParticleSlot, this.activeMoveID, repetition, origin)[age];
                    if (state === undefined || !state.Alive) continue;
                    mat4.fromTranslation(this.particleMatrix, [origin[0] + state.Position[0], origin[1] + state.Position[1],
                        origin[2] + state.Position[2]]);
                    mat4.rotateY(this.particleMatrix, this.particleMatrix, moveEffectAngle(state.Rotation[1]));
                    mat4.rotateX(this.particleMatrix, this.particleMatrix, moveEffectAngle(state.Rotation[0]));
                    mat4.rotateZ(this.particleMatrix, this.particleMatrix, moveEffectAngle(state.Rotation[2]));
                    const scale = Number.isFinite(state.Scale) ? state.Scale : 1;
                    mat4.scale(this.particleMatrix, this.particleMatrix, [scale, scale, scale]);
                    const localMatrices = draw.FrameMatrices[state.ModelAnimationFrame % draw.FrameMatrices.length];
                    for (let i = 0; i < draw.Matrices.length; i++)
                        mat4.mul(draw.Matrices[i], this.particleMatrix, localMatrices[i]);
                    const colorMode = draw.GeometryDrawCall.stadiumModelParticleColorMode;
                    if (colorMode === 'none') draw.DrawCall.setCombineColors(null, null);
                    else if (colorMode === 'alpha') draw.DrawCall.setCombineColors(
                        [draw.GeometryDrawCall.DP_PrimColor[0], draw.GeometryDrawCall.DP_PrimColor[1],
                            draw.GeometryDrawCall.DP_PrimColor[2], state.Alpha / 255],
                        [draw.GeometryDrawCall.DP_EnvColor[0], draw.GeometryDrawCall.DP_EnvColor[1],
                            draw.GeometryDrawCall.DP_EnvColor[2], draw.GeometryDrawCall.DP_EnvColor[3]]);
                    else draw.DrawCall.setCombineColors(
                        [state.PrimitiveColor[0] / 255, state.PrimitiveColor[1] / 255,
                            state.PrimitiveColor[2] / 255, state.Alpha / 255],
                        [state.EnvironmentColor[0] / 255, state.EnvironmentColor[1] / 255,
                            state.EnvironmentColor[2] / 255, 1]);
                    draw.DrawCall.visible = rendered = true;
                }
                if (rendered) break;
            }
        }
    }

    private updateCustomEffects(frame: number, modelPose: PokemonModelPose, viewerInput: Viewer.ViewerRenderInput,
                                viewMatrix: mat4): void {
        for (const draw of this.assets.customRingDraws) {
            draw.DrawCall.visible = draw.ArchiveID === this.custom.RingArchive && draw.Frame === frame &&
                (this.custom.RingModes & (1 << draw.Mode)) !== 0;
            if (draw.DrawCall.visible) mat4.fromTranslation(draw.Matrix, this.customOrigin);
        }
        for (const draw of this.assets.spiralRibbonDraws) {
            draw.DrawCall.visible = draw.Palette === this.custom.SpiralRibbonPalette && draw.Frame === frame;
            if (draw.DrawCall.visible) mat4.fromTranslation(draw.Matrix, this.customOrigin);
        }
        mat4.invert(this.cameraWorld, viewMatrix);
        const waveDepth = 140 / ((viewerInput.camera.fovY * 180 / Math.PI) / 30);
        for (const draw of this.assets.waveGridDraws) {
            draw.DrawCall.visible = draw.Kind === this.custom.WaveGridKind &&
                draw.ArchiveID === this.custom.WaveGridArchive && draw.Frame === frame;
            if (!draw.DrawCall.visible) continue;
            mat4.copy(draw.Matrix, this.cameraWorld);
            mat4.translate(draw.Matrix, draw.Matrix, [0, 0, -waveDepth]);
            mat4.rotateX(draw.Matrix, draw.Matrix, Math.PI / 2);
        }
        for (const draw of this.assets.pointTrailDraws) {
            const lifecycleFrame = draw.Kind === 'prismaticPointTrail' ? frame % 60 : frame;
            draw.DrawCall.visible = draw.Kind === this.custom.PointTrailKind && draw.Frame === lifecycleFrame;
            if (draw.DrawCall.visible) mat4.fromTranslation(draw.Matrix, this.customOrigin);
        }
        if (!modelPose.getAttachmentPosition(0x64, this.returningOrigin)) vec3.copy(this.returningOrigin, this.customOrigin);
        for (const draw of this.assets.returningRibbonDraws) {
            draw.DrawCall.visible = draw.ArchiveID === this.custom.ReturningRibbonArchive && draw.Frame === frame % 50;
            if (draw.DrawCall.visible) mat4.fromTranslation(draw.Matrix, this.returningOrigin);
        }
        for (const draw of this.assets.needleProjectileDraws) {
            draw.DrawCall.visible = draw.Kind === this.custom.NeedleProjectileKind && draw.Frame === frame % 50;
            if (draw.DrawCall.visible) mat4.fromTranslation(draw.Matrix, this.customOrigin);
        }
        for (const draw of this.assets.plantParticleDraws) {
            draw.DrawCall.visible = draw.Kind === this.custom.PlantParticleKind &&
                draw.ArchiveID === this.custom.PlantParticleArchive && draw.Frame === frame;
            if (draw.DrawCall.visible) mat4.fromTranslation(draw.Matrix, this.customOrigin);
        }
        for (const draw of this.assets.swiftDraws) {
            draw.DrawCall.visible = this.custom.SwiftArchive >= 0 && draw.ArchiveID === this.custom.SwiftArchive && draw.Frame === frame;
            if (draw.DrawCall.visible) mat4.fromTranslation(draw.Matrix, this.customOrigin);
        }
    }

    private updateSpriteParticles(frame: number, modelPose: PokemonModelPose, modelMatrix: mat4, modelSize: vec3): void {
        for (const draw of this.assets.effectSpriteDraws) {
            const descriptor = this.archive.MoveEffects.RenderDescriptors[draw.DescriptorIndex];
            const capacity = draw.Matrices[0].length;
            for (let textureFrame = 0; textureFrame < draw.Matrices.length; textureFrame++) for (let i = 0; i < capacity; i++) {
                mat4.fromScaling(draw.Matrices[textureFrame][i], [0, 0, 0]);
                draw.DrawCalls[textureFrame].setInstanceCombineColors(i, null, null);
            }
            let instance = 0;
            for (const record of draw.Spawns) {
                const origin = this.origin(modelMatrix, modelSize, modelPose, record.Spawn, record.Target);
                for (let repetition = 0; repetition < moveEffectEmissionCount(record.Spawn); repetition++) {
                    const emissionFrame = moveEffectFirstEmissionFrame(record.Spawn) +
                        repetition * Math.max(1, record.Spawn.Interval);
                    const age = frame - emissionFrame;
                    if (age < 0 || age >= moveEffectPreviewFrames) continue;
                    for (let particle = 0; particle < Math.max(1, record.Spawn.BurstCount) && instance < capacity;
                         particle++, instance++) {
                        const state = this.simulator.simulateParticle(
                            record.Spawn, particle, this.activeMoveID, repetition, origin)[age];
                        if (state === undefined || !state.Alive) continue;
                        const textureFrame = ((state.TextureFrame % descriptor.TextureFrameCount) +
                            descriptor.TextureFrameCount) % descriptor.TextureFrameCount;
                        const matrix = draw.Matrices[textureFrame][instance];
                        if (descriptor.GeometryKind.startsWith('screen320x240')) {
                            mat4.fromTranslation(matrix, [state.ScreenPosition[0], state.ScreenPosition[1], 0]);
                            mat4.rotateZ(matrix, matrix, moveEffectAngle(state.Rotation[2]) + Math.PI);
                        } else {
                            mat4.fromTranslation(matrix, [origin[0] + state.Position[0], origin[1] + state.Position[1],
                                origin[2] + state.Position[2]]);
                            if (descriptor.Billboard) mat4.rotateZ(matrix, matrix, moveEffectAngle(state.Rotation[2]));
                            else {
                                mat4.rotateY(matrix, matrix, moveEffectAngle(state.Rotation[1]));
                                mat4.rotateX(matrix, matrix, moveEffectAngle(state.Rotation[0]));
                                mat4.rotateZ(matrix, matrix, moveEffectAngle(state.Rotation[2]));
                            }
                        }
                        const scale = Number.isFinite(state.Scale) ? state.Scale : 1;
                        mat4.scale(matrix, matrix, [scale, scale, scale]);
                        if (descriptor.RenderFunction === 0x317D4)
                            draw.DrawCalls[textureFrame].setInstanceCombineColors(instance, [1, 1, 1, state.Alpha / 255],
                                [state.PrimitiveColor[0] / 255, state.PrimitiveColor[1] / 255,
                                    state.PrimitiveColor[2] / 255, 1]);
                        else draw.DrawCalls[textureFrame].setInstanceCombineColors(instance,
                            [state.PrimitiveColor[0] / 255, state.PrimitiveColor[1] / 255,
                                state.PrimitiveColor[2] / 255, state.Alpha / 255],
                            [state.EnvironmentColor[0] / 255, state.EnvironmentColor[1] / 255,
                                state.EnvironmentColor[2] / 255, 1]);
                    }
                }
            }
        }
    }

    private prepareScreenFlashes(frame: number): void {
        const manager = this.renderHelper.renderInstManager;
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(screenFlashBindingLayouts);
        for (const spawn of this.screenFlashSpawns) for (let repetition = 0;
             repetition < moveEffectEmissionCount(spawn); repetition++) {
            const emissionFrame = moveEffectFirstEmissionFrame(spawn) + repetition * Math.max(1, spawn.Interval);
            const age = frame - emissionFrame;
            if (age < 0) continue;
            const flash = this.simulator.simulateParticle(spawn, 0, this.activeMoveID, repetition)[age];
            if (flash === undefined || !flash.Alive || flash.Alpha === 0) continue;
            const renderInst = manager.newRenderInst();
            renderInst.setBindingLayouts(screenFlashBindingLayouts);
            renderInst.setGfxProgram(this.screenFlashProgram);
            renderInst.setVertexInput(null, null, null);
            renderInst.setDrawCount(3);
            renderInst.setMegaStateFlags(screenFlashMegaState);
            renderInst.sortKey = 0xFE000000;
            const color = renderInst.allocateUniformBufferF32(MoveEffectScreenFlashProgram.ub_Color, 4);
            fillVec4(color, 0, flash.PrimitiveColor[0] / 255, flash.PrimitiveColor[1] / 255,
                flash.PrimitiveColor[2] / 255, flash.Alpha / 255);
            manager.submitRenderInst(renderInst);
        }
        manager.popTemplate();
    }

    public destroy(): void {
        this.assets.destroy(this.device);
    }
}
