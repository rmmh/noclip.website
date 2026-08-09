import ArrayBufferSlice from '../ArrayBufferSlice.js';
import type { PokemonAnimation, PokemonGeoNode } from './archive.js';

export type MoveEffectCustomLifecycle = 'mistRing' | 'hazeRings' | 'cyanSpiralRibbon' | 'whiteSpiralRibbon' |
    'yellowSpiralRibbon' | 'radialWaveGrid' | 'randomWaveGrid' | 'subtleWaveGrid' | 'cyanPointTrail' |
    'whitePointTrail' | 'yellowPointTrail' | 'prismaticPointTrail' | 'returningRibbonTrails' |
    'needleProjectile' | 'archingNeedleVolley' | 'razorLeafPool' | 'petalDancePool' | 'swiftStarPool';

export const customMoveEffectLifecycleBySpawnFunction = new Map<number, MoveEffectCustomLifecycle>([
    [0x59684, 'mistRing'], [0x59910, 'hazeRings'],
    [0x59D7C, 'cyanSpiralRibbon'], [0x5A390, 'whiteSpiralRibbon'], [0x5A480, 'yellowSpiralRibbon'],
    [0x59C84, 'cyanPointTrail'], [0x5A298, 'whitePointTrail'], [0x5A6F8, 'yellowPointTrail'],
    [0x5B580, 'prismaticPointTrail'], [0x5ADDC, 'returningRibbonTrails'],
    [0x5B2C8, 'needleProjectile'], [0x5B0B0, 'archingNeedleVolley'],
    [0x5A7F0, 'razorLeafPool'], [0x5A9F0, 'petalDancePool'], [0x59FE0, 'swiftStarPool'],
    [0x5ABF0, 'radialWaveGrid'], [0x5AC94, 'randomWaveGrid'], [0x5AD38, 'subtleWaveGrid'],
]);

export function getCustomMoveEffectLifecycle(spawnFunction: number): MoveEffectCustomLifecycle | null {
    return customMoveEffectLifecycleBySpawnFunction.get(spawnFunction) ?? null;
}

export interface MoveEffectScript {
    AttackerSetup: number[];
    AttackerAction: number[];
    TargetAction: number[];
    AttackerAttachments: number[];
    TargetAttachments: number[];
}

export interface MoveEffectPrimitive {
    SetupFunction: number;
    SpawnFunction: number;
    UpdateFunction: number;
    RenderFunction: number;
    ParticleStyles: number[];
    ParticleSpawns: MoveEffectParticleSpawn[];
    ModelTints: MoveEffectModelTint[];
    CustomLifecycle: MoveEffectCustomLifecycle | null;
}

export interface MoveEffectModelTint {
    Delay: number;
    UpdateFunction: number;
    Arguments: number[];
}

export interface MoveEffectParticleSpawn {
    Delay: number;
    Interval: number;
    Mode: number;
    BurstCount: number;
    UpdateFunction: number;
    ParticleStyle: number;
    /** Model/animation resource pairs loaded by the original update callback. */
    ModelResources: { ModelResourceID: number; AnimationResourceID: number; Reverse: boolean }[];
    /** Duration of the model animation loaded by the update callback, or zero for static/non-model particles. */
    ModelAnimationFrameCount: number;
    Arguments: number[];
    InitialState: MoveEffectParticleInitialState;
    PaletteIndices: number[];
    PrimitiveColorIndices: number[];
    EnvironmentColorIndices: number[];
    BehaviorCalls: MoveEffectParticleBehaviorCall[];
}

/** Fields assigned by fragment62 initialize_scheduled_move_particles when a scheduled particle is created. */
export interface MoveEffectParticleInitialState {
    A6: number;
    AA: number;
    CC: number;
    CD: number;
    CF: number;
    CE: number;
}

export interface MoveEffectParticleBehaviorCall {
    Function: number;
    Arguments: number[];
}

// gMoveEffectColors in fragment34. Particle callbacks select entries by index with
// set_particle_color_pair; keeping the table here preserves the game's authored colors.
export const moveEffectColors: readonly [number, number, number][] = [
    [0,0,0],[0,20,30],[0,35,45],[64,64,64],[70,85,85],[110,110,110],[128,128,128],[180,200,200],
    [200,255,255],[230,240,240],[255,255,255],[255,0,0],[240,40,40],[255,128,128],[170,50,0],[150,0,0],
    [100,0,0],[70,20,0],[50,10,10],[255,128,0],[255,160,0],[240,220,216],[255,200,200],[255,120,200],
    [255,0,100],[255,255,0],[255,255,100],[255,255,155],[255,255,200],[255,200,0],[215,255,115],[200,200,0],
    [150,150,50],[100,100,0],[128,128,80],[0,255,0],[40,255,40],[100,255,100],[128,255,128],[155,255,200],
    [80,100,60],[200,255,0],[200,200,0],[150,180,0],[0,150,0],[0,100,0],[0,0,255],[50,50,255],
    [0,50,255],[0,100,255],[0,120,255],[32,124,255],[128,128,255],[100,200,255],[0,255,255],[100,255,255],
    [180,255,255],[200,255,255],[70,100,120],[255,0,255],[255,50,255],[215,0,255],[150,0,200],[100,0,255],
    [255,50,255],[120,30,120],
];

// gMoveEffectColorPairs. set_particle_color_pair selects primitive/environment palette entries.
export const moveEffectColorPairs: readonly [number, number][] = [
    [25,12],[10,59],[0,12],[8,49],[42,35],[25,31],[54,50],[25,11],[59,60],[12,12],[10,28],[10,20],[10,53],[10,36],
    [10,12],[25,20],[25,12],[21,10],[14,17],[8,55],[54,48],[10,63],[11,0],[10,25],[10,54],[55,49],[25,11],[0,59],
    [0,1],[10,10],[4,2],[41,44],[10,0],[12,16],[27,59],[10,39],[20,11],[10,28],[10,53],[10,8],[10,49],[28,26],
    [26,11],[20,15],[26,20],[20,0],[11,0],[54,45],[35,44],[26,32],[33,33],[10,10],[25,44],[59,60],[43,10],[62,10],
    [25,35],[10,35],[11,0],[10,26],[10,53],[10,53],[10,23],[10,63],[10,49],[10,23],[10,19],[60,62],[21,21],[62,62],
    [35,35],[19,12],[25,19],[22,12],[28,25],[57,47],[10,57],[56,53],[56,57],[28,26],[9,53],
];

/** Model/animation resource pairs selected by initialize_move_effect_model_particle. */
export function defaultParticleModelResourceIDs(paletteIndex: number): readonly [number, number] | null {
    switch (paletteIndex) {
    case 0: return [0x66, 0x67];
    case 1: return [0x68, 0x69];
    case 2: return [0x6A, 0x6B];
    case 3: return [0x73, 0x74]; // Leer eyes
    case 4: return [0x78, 0x79];
    case 5: return [0x7B, 0x7C];
    case 6: return [0x7D, 0x7E];
    case 7: return [0x7F, 0x80];
    case 8: case 42: case 43: return [0x81, 0x82];
    case 9: return [0x83, 0x84];
    case 10: return [0x85, 0x86];
    case 11: return [0x88, 0x89];
    case 12: return [0x8A, 0x8B];
    case 13: return [0x9A, 0x9B];
    case 14: case 15: return [0x9C, -1];
    case 16: return [0x9D, 0x9E];
    case 17: return [0xA3, 0xA5];
    case 18: return [0xA3, 0xA4];
    case 19: return [0xA3, 0xBB];
    case 20: return [0xAA, 0xAB];
    case 21: return [0xAD, -1];
    case 22: return [0x5C, 0x5D];
    case 23: case 24: return [0xAE, -1];
    case 25: return [0xAF, 0xB0];
    case 26: return [0xB6, -1];
    case 27: return [0xB3, 0xB4];
    case 28: return [0xB3, 0xB5];
    case 29: return [0xBE, 0xBF];
    case 30: return [0x23, 0x24];
    case 31: return [0xC0, 0xC1];
    case 32: return [0xB1, 0xB2];
    case 33: return [0xB7, -1];
    case 34: return [0x2E, 0x2F];
    case 35: return [0x3B, 0x3C];
    case 36: return [0x3D, 0x3E];
    case 37: return [0x40, 0x41];
    case 38: return [0x4B, 0x4C];
    case 39: return [0x4D, 0x4E];
    case 40: return [0x57, 0x58]; // Swords Dance swords
    case 41: return [0x5A, 0x5B];
    default: return null;
    }
}

interface MoveEffectResourceBase {
    ArchiveID: number;
    ResourceID: number;
    DataOffset: number;
}

export type MoveEffectResource =
    | MoveEffectResourceBase & { Type: 1 | 2 }
    | MoveEffectResourceBase & { Type: 3; GeoNodes: PokemonGeoNode[] }
    | MoveEffectResourceBase & { Type: 4; Animation: PokemonAnimation };

export interface MoveEffectMetadata {
    MoveCount: number;
    AttackerPrimitiveCount: number;
    TargetPrimitiveCount: number;
    AttackerPrimitives: MoveEffectPrimitive[];
    TargetPrimitives: MoveEffectPrimitive[];
    Resources: MoveEffectResource[];
    RenderDescriptors: MoveEffectRenderDescriptor[];
    ParticleStyles: MoveEffectParticleStyle[];
    Scripts: MoveEffectScript[];
    /** Attacker-side battle-result primitives which follow the selected move. */
    MoveResultPrimitives: number[][];
    MoveResultResourceBanks: number[][];
}

export interface MoveEffectRenderDescriptor {
    Flags: number;
    TextureLoadFunction: number;
    RenderFunction: number;
    ResourceID: number;
    TextureFormat: number;
    TextureSize: number;
    Width: number;
    Height: number;
    TextureFrameCount: number;
    TextureFrameMode: 'static' | 'global' | 'particle';
    GeometryKind: MoveEffectGeometryKind;
    Billboard: boolean;
    GeometryResourceID: number;
    SecondaryResourceID: number;
    SecondaryTextureFormat: number;
    SecondaryTextureSize: number;
    SecondaryWidth: number;
    SecondaryHeight: number;
    DualTextureMode: 'none' | 'colorAndAlpha' | 'colorOnly';
}

export type MoveEffectGeometryKind = 'center24' | 'center32' | 'bottom32' | 'right32' | 'triangle32' | 'tall64' | 'bottom64' |
    'center64' | 'ground128' | 'color32' | 'screen320x240' | 'screen320x240Double' | 'screen320x240Quarter' |
    'bottom128x64' | 'beam32' | 'beam16' | 'beam8' |
    'beamTriangle8' | 'beamTriangle32' | 'tall96';

export interface MoveEffectParticleStyle {
    Type: number;
    RenderDescriptor: number;
    CustomRenderFunction: number;
}

export interface MoveEffectResourceBank {
    ArchiveID: number;
    Data: ArrayBufferSlice;
}

export interface MoveEffectArchive {
    Data: ArrayBufferSlice;
    MoveEffectResourceBanks: MoveEffectResourceBank[];
    MoveEffects: MoveEffectMetadata;
}

export type ResolvedMoveEffectResource = MoveEffectResource & {
    Data: ArrayBufferSlice;
};

export interface ResolvedMoveEffect {
    Script: MoveEffectScript;
    AttackerSetup: MoveEffectPrimitive[];
    AttackerAction: MoveEffectPrimitive[];
    TargetAction: MoveEffectPrimitive[];
    ResultAction: MoveEffectPrimitive[];
    Resources: Map<number, ResolvedMoveEffectResource>;
    ResultResources: Map<number, ResolvedMoveEffectResource>;
}

// register_move_effect_lifecycle stores update/render pairs in gMoveEffectUpdateCallbacks/gMoveEffectDrawCallbacks.
export const moveEffectLifecycleSlotCount = 8;

/** Reproduces install_move_effect_resource_list/install_move_effect_resource_overlays's move-local resource overlay. */
export class MoveEffectResolver {
    private resourceBanks = new Map<number, ArrayBufferSlice>();
    private resourcesByBank = new Map<number, MoveEffectResource[]>();

    constructor(private archive: MoveEffectArchive) {
        for (const bank of archive.MoveEffectResourceBanks)
            this.resourceBanks.set(bank.ArchiveID, bank.Data);
        for (const resource of archive.MoveEffects.Resources) {
            let resources = this.resourcesByBank.get(resource.ArchiveID);
            if (resources === undefined)
                this.resourcesByBank.set(resource.ArchiveID, resources = []);
            resources.push(resource);
        }
    }

    public resolve(moveID: number): ResolvedMoveEffect {
        const metadata = this.archive.MoveEffects;
        const script = metadata.Scripts[moveID];
        if (script === undefined) throw new Error(`move effect ${moveID} outside script table`);

        // Entry zero is installed first by initialize_move_effect_resources. Move attachment banks
        // are then installed in attacker/target list order, with later resource
        // IDs replacing earlier ones in gMoveEffectResources.
        const resources = new Map<number, ResolvedMoveEffectResource>();
        const installBank = (resources: Map<number, ResolvedMoveEffectResource>, archiveID: number): void => {
            const data = this.resourceBanks.get(archiveID);
            if (data === undefined) throw new Error(`move effect resource bank ${archiveID} is missing`);
            for (const resource of this.resourcesByBank.get(archiveID) ?? [])
                resources.set(resource.ResourceID, { ...resource, Data: data });
        };
        installBank(resources, 0);
        for (const archiveID of [...script.AttackerAttachments, ...script.TargetAttachments]) installBank(resources, archiveID);
        const resultResources = new Map(resources);
        for (const archiveID of metadata.MoveResultResourceBanks[moveID] ?? []) installBank(resultResources, archiveID);

        return {
            Script: script,
            AttackerSetup: script.AttackerSetup.map((id) => metadata.AttackerPrimitives[id]),
            AttackerAction: script.AttackerAction.map((id) => metadata.AttackerPrimitives[id]),
            TargetAction: script.TargetAction.map((id) => metadata.TargetPrimitives[id]),
            ResultAction: (metadata.MoveResultPrimitives[moveID] ?? []).map((id) => metadata.AttackerPrimitives[id]),
            Resources: resources,
            ResultResources: resultResources,
        };
    }
}
