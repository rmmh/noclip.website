import { mat4 } from 'gl-matrix';
import { RSPSharedOutput } from '../BanjoKazooie/f3dex.js';
import { RenderData } from '../BanjoKazooie/render.js';
import { GfxDevice, GfxTexture } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { MoveEffectArchive, MoveEffectParticleSpawn } from './effects.js';
import * as F3DEX2 from './F3DEX2.js';
import { PointTrailKind, WaveGridKind } from './move_effect_geometry.js';
import {
    CustomMoveEffectOutputs, CustomMoveEffectSelection, NeedleProjectileKind, PlantParticleKind, SpiralRibbonPalette,
    compileCustomMoveEffects,
} from './move_effect_custom_renderer.js';
import { compileParticleEffects } from './move_effect_particle_renderer.js';
import { compileMoveEffectModels } from './move_effect_model_renderer.js';
import { DrawCallInstance } from './render.js';

export type { NeedleProjectileKind, PlantParticleKind, SpiralRibbonPalette };
export type MoveEffectPreviewSide = 'attacker' | 'target' | 'both';

export interface MoveEffectSpriteDraw {
    DescriptorIndex: number;
    ArchiveID: number;
    DrawCalls: DrawCallInstance[];
    Matrices: mat4[][];
    Spawns: { Spawn: MoveEffectParticleSpawn; Target: boolean }[];
}

export interface MoveEffectSpriteSource {
    DescriptorIndex: number;
    ArchiveID: number;
    GeometryDrawCall: F3DEX2.DrawCall;
    Capacity: number;
}

export interface MoveEffectModelDraw {
    ArchiveID: number;
    ResourceID: number;
    AnimationResourceID: number;
    GeometryDrawCall: F3DEX2.DrawCall;
    DrawCall: DrawCallInstance;
    Matrices: mat4[];
    FrameMatrices: mat4[][];
    ParticleSlot: number;
}

interface EffectFrameSource {
    GeometryDrawCall: F3DEX2.DrawCall;
}

type EffectFrameDraw<T extends EffectFrameSource> = T & {
    DrawCall: DrawCallInstance;
    Matrix: mat4;
};

interface CustomRingFrameSource extends EffectFrameSource {
    ArchiveID: number;
    Frame: number;
    Mode: 0 | 1;
}
export type CustomRingFrameDraw = EffectFrameDraw<CustomRingFrameSource>;

interface SpiralRibbonFrameSource extends EffectFrameSource {
    Frame: number;
    Palette: SpiralRibbonPalette;
}
export type SpiralRibbonFrameDraw = EffectFrameDraw<SpiralRibbonFrameSource>;

interface WaveGridFrameSource extends EffectFrameSource {
    ArchiveID: number;
    Frame: number;
    Kind: WaveGridKind;
}
export type WaveGridFrameDraw = EffectFrameDraw<WaveGridFrameSource>;

interface PointTrailFrameSource extends EffectFrameSource {
    Frame: number;
    Kind: PointTrailKind;
}
export type PointTrailFrameDraw = EffectFrameDraw<PointTrailFrameSource>;

interface ReturningRibbonFrameSource extends EffectFrameSource {
    ArchiveID: number;
    Frame: number;
}
export type ReturningRibbonFrameDraw = EffectFrameDraw<ReturningRibbonFrameSource>;

interface NeedleProjectileFrameSource extends EffectFrameSource {
    Frame: number;
    Kind: NeedleProjectileKind;
}
export type NeedleProjectileFrameDraw = EffectFrameDraw<NeedleProjectileFrameSource>;

interface PlantParticleFrameSource extends EffectFrameSource {
    ArchiveID: number;
    Frame: number;
    Kind: PlantParticleKind;
}
export type PlantParticleFrameDraw = EffectFrameDraw<PlantParticleFrameSource>;

interface SwiftFrameSource extends EffectFrameSource {
    ArchiveID: number;
    Frame: number;
}
export type SwiftFrameDraw = EffectFrameDraw<SwiftFrameSource>;

function collectEffectFrames<TOutput extends { Output: F3DEX2.RSPOutput }, TSource extends EffectFrameSource>(
    outputs: TOutput[], describe: (output: TOutput, drawCall: F3DEX2.DrawCall) => TSource,
): TSource[] {
    const sources: TSource[] = [];
    for (const output of outputs)
        for (const drawCall of output.Output.drawCalls)
            sources.push(describe(output, drawCall));
    return sources;
}

function instantiateEffectFrames<T extends EffectFrameSource>(renderData: RenderData, sources: T[],
                                                               firstSortKey: number, depthWrite = false): EffectFrameDraw<T>[] {
    return sources.map((source, index) => {
        const matrix = mat4.create();
        const drawCall = new DrawCallInstance(renderData, source.GeometryDrawCall, [matrix], 0, 5,
            firstSortKey + index, false, false);
        drawCall.visible = false;
        drawCall.setDepthWriteEnabled(depthWrite);
        return { ...source, DrawCall: drawCall, Matrix: matrix };
    });
}

export class MoveEffectAssets {
    public effectRenderData: RenderData | null = null;
    public customEffectRenderData: RenderData | null = null;
    public effectSpriteSources: MoveEffectSpriteSource[] = [];
    public effectSpriteDraws: MoveEffectSpriteDraw[] = [];
    public modelParticleDraws: MoveEffectModelDraw[] = [];
    public customRingDraws: CustomRingFrameDraw[] = [];
    public spiralRibbonDraws: SpiralRibbonFrameDraw[] = [];
    public waveGridDraws: WaveGridFrameDraw[] = [];
    public pointTrailDraws: PointTrailFrameDraw[] = [];
    public returningRibbonDraws: ReturningRibbonFrameDraw[] = [];
    public needleProjectileDraws: NeedleProjectileFrameDraw[] = [];
    public plantParticleDraws: PlantParticleFrameDraw[] = [];
    public swiftDraws: SwiftFrameDraw[] = [];
    public customEffectDraws: EffectFrameDraw<EffectFrameSource>[] = [];
    private customSelectionKey = '';

    constructor(private moveEffectArchive: MoveEffectArchive, private battleScale: number,
                private renderHelper: GfxRenderHelper) {}

    public selectStandardEffects(device: GfxDevice, activeSpawns: readonly MoveEffectParticleSpawn[],
                                 activeResourceKeys: ReadonlySet<string>): void {
        this.effectRenderData?.destroy(device);
        this.effectRenderData = null;
        this.effectSpriteSources = [];
        this.effectSpriteDraws = [];
        this.modelParticleDraws = [];
        if (activeSpawns.length === 0) return;

        const sharedOutput = new RSPSharedOutput();
        const particles = compileParticleEffects(sharedOutput, this.moveEffectArchive, activeSpawns, activeResourceKeys);
        const models = compileMoveEffectModels(sharedOutput, this.moveEffectArchive, activeSpawns, activeResourceKeys);
        if (sharedOutput.vertices.length === 0) return;

        this.effectRenderData = new RenderData(device, this.renderHelper.renderCache, sharedOutput);
        this.buildParticleSources(particles);
        this.buildModelParticleDraws(models, activeSpawns);
    }

    public selectCustomEffects(device: GfxDevice, selection: CustomMoveEffectSelection | null): void {
        const selectionKey = JSON.stringify(selection);
        if (selectionKey === this.customSelectionKey) return;
        this.customSelectionKey = selectionKey;
        this.customEffectRenderData?.destroy(device);
        this.customEffectRenderData = null;
        this.customRingDraws = [];
        this.spiralRibbonDraws = [];
        this.waveGridDraws = [];
        this.pointTrailDraws = [];
        this.returningRibbonDraws = [];
        this.needleProjectileDraws = [];
        this.plantParticleDraws = [];
        this.swiftDraws = [];
        this.customEffectDraws = [];
        if (selection === null) return;

        const sharedOutput = new RSPSharedOutput();
        const outputs = compileCustomMoveEffects(sharedOutput, this.moveEffectArchive, this.battleScale, selection);
        if (sharedOutput.vertices.length === 0) return;
        this.customEffectRenderData = new RenderData(device, this.renderHelper.renderCache, sharedOutput);
        this.buildCustomDraws(outputs);
    }

    public destroy(device: GfxDevice): void {
        this.effectRenderData?.destroy(device);
        this.customEffectRenderData?.destroy(device);
    }

    /** Bind the live actor capture to every model draw carrying callback 0x841050e4. */
    public setCurrentPokemonCaptureTexture(texture: GfxTexture): void {
        for (const draw of this.modelParticleDraws)
            draw.DrawCall.setPokemonStadiumGsCurrentPokemonTexture(texture);
    }

    private buildModelParticleDraws(models: ReturnType<typeof compileMoveEffectModels>, activeSpawns: readonly MoveEffectParticleSpawn[]): void {
        let order = this.effectSpriteSources.length;
        for (const model of models) for (const geometryDrawCall of model.Output.drawCalls) {
            const capacity = Math.max(1, ...activeSpawns
                .filter((spawn) => spawn.ModelResources.some((pair) =>
                    pair.ModelResourceID === model.ResourceID && pair.AnimationResourceID === model.AnimationResourceID))
                .map((spawn) => spawn.BurstCount));
            for (let particleSlot = 0; particleSlot < capacity; particleSlot++) {
                const matrices = model.FrameMatrices[0].map(() => mat4.create());
                const drawCall = new DrawCallInstance(this.effectRenderData!, geometryDrawCall, matrices,
                    geometryDrawCall.stadiumBillboard, 5, order++, true, false);
                drawCall.visible = false;
                drawCall.setDepthWriteEnabled(false);
                this.modelParticleDraws.push({ ArchiveID: model.ArchiveID, ResourceID: model.ResourceID,
                    AnimationResourceID: model.AnimationResourceID, ParticleSlot: particleSlot,
                    GeometryDrawCall: geometryDrawCall,
                    DrawCall: drawCall, Matrices: matrices, FrameMatrices: model.FrameMatrices });
            }
        }
    }

    private buildParticleSources(particles: ReturnType<typeof compileParticleEffects>): void {
        for (let outputIndex = 0; outputIndex < particles.Outputs.length; outputIndex++) {
            const descriptor = particles.Descriptors[outputIndex];
            for (const drawCall of particles.Outputs[outputIndex].drawCalls) {
                this.effectSpriteSources.push({
                    DescriptorIndex: descriptor.DescriptorIndex,
                    ArchiveID: descriptor.ArchiveID,
                    GeometryDrawCall: drawCall,
                    Capacity: particles.Matrices[outputIndex].length,
                });
            }
        }
    }

    private buildCustomDraws(outputs: CustomMoveEffectOutputs): void {
        const customRingSources = collectEffectFrames(outputs.CustomRings, (source, drawCall) => ({
            ArchiveID: source.ArchiveID, Frame: source.Frame, Mode: source.Mode, GeometryDrawCall: drawCall,
        }));
        const spiralRibbonSources = collectEffectFrames(outputs.SpiralRibbons, (source, drawCall) => ({
            Frame: source.Frame, Palette: source.Palette, GeometryDrawCall: drawCall,
        }));
        const waveGridSources = collectEffectFrames(outputs.WaveGrids, (source, drawCall) => ({
            ArchiveID: source.ArchiveID, Frame: source.Frame, Kind: source.Kind, GeometryDrawCall: drawCall,
        }));
        const pointTrailSources = collectEffectFrames(outputs.PointTrails, (source, drawCall) => ({
            Frame: source.Frame, Kind: source.Kind, GeometryDrawCall: drawCall,
        }));
        const returningRibbonSources = collectEffectFrames(outputs.ReturningRibbons, (source, drawCall) => ({
            ArchiveID: source.ArchiveID, Frame: source.Frame, GeometryDrawCall: drawCall,
        }));
        const needleProjectileSources = collectEffectFrames(outputs.NeedleProjectiles, (source, drawCall) => ({
            Frame: source.Frame, Kind: source.Kind, GeometryDrawCall: drawCall,
        }));
        const plantParticleSources = collectEffectFrames(outputs.PlantParticles, (source, drawCall) => ({
            ArchiveID: source.ArchiveID, Frame: source.Frame, Kind: source.Kind, GeometryDrawCall: drawCall,
        }));
        const swiftSources = collectEffectFrames(outputs.SwiftStars, (source, drawCall) => ({
            ArchiveID: source.ArchiveID, Frame: source.Frame, GeometryDrawCall: drawCall,
        }));

        let nextSortKey = this.effectSpriteSources.length + this.modelParticleDraws.length;
        const instantiate = <T extends EffectFrameSource>(sources: T[]): EffectFrameDraw<T>[] => {
            const draws = instantiateEffectFrames(this.customEffectRenderData!, sources, nextSortKey);
            nextSortKey += sources.length;
            return draws;
        };
        this.customRingDraws = instantiate(customRingSources);
        this.spiralRibbonDraws = instantiate(spiralRibbonSources);
        this.waveGridDraws = instantiate(waveGridSources);
        this.pointTrailDraws = instantiate(pointTrailSources);
        this.returningRibbonDraws = instantiate(returningRibbonSources);
        this.needleProjectileDraws = instantiateEffectFrames(this.customEffectRenderData!, needleProjectileSources, nextSortKey, true);
        nextSortKey += needleProjectileSources.length;
        this.plantParticleDraws = instantiate(plantParticleSources);
        this.swiftDraws = instantiate(swiftSources);
        this.customEffectDraws.push(
            ...this.customRingDraws,
            ...this.spiralRibbonDraws,
            ...this.waveGridDraws,
            ...this.pointTrailDraws,
            ...this.returningRibbonDraws,
            ...this.needleProjectileDraws,
            ...this.plantParticleDraws,
            ...this.swiftDraws,
        );
    }
}
