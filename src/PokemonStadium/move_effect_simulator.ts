import { MoveEffectModelTint, MoveEffectParticleSpawn } from './effects.js';
import { StadiumMoveEffectCallbackVM, StadiumMoveEffectParticleSnapshot, StadiumMoveEffectParticleState } from './MoveEffectVM.js';
import { moveEffectPreviewFrames } from './move_effect_geometry.js';

export class MoveEffectSimulator {
    private readonly callbackVM: StadiumMoveEffectCallbackVM;
    private readonly particleSimulations = new Map<MoveEffectParticleSpawn, {
        MoveID: number;
        Origin: readonly [number, number, number];
        Frames: StadiumMoveEffectParticleSnapshot[];
    }[]>();
    private readonly modelTintSpawns = new Map<MoveEffectModelTint, MoveEffectParticleSpawn>();

    constructor(fragment: import('../ArrayBufferSlice.js').default) {
        this.callbackVM = new StadiumMoveEffectCallbackVM(fragment);
    }

    public clear(): void {
        this.particleSimulations.clear();
    }

    public simulateParticle(spawn: MoveEffectParticleSpawn, particleIndex: number, moveID: number,
                            emissionIndex = 0, attachmentOrigin: ArrayLike<number> = [0, 0, 0]): StadiumMoveEffectParticleSnapshot[] {
        let particles = this.particleSimulations.get(spawn);
        if (particles === undefined) this.particleSimulations.set(spawn, particles = []);
        const cacheIndex = emissionIndex * Math.max(1, spawn.BurstCount) + particleIndex;
        const origin = [attachmentOrigin[0], attachmentOrigin[1], attachmentOrigin[2]] as const;
        const cached = particles[cacheIndex];
        if (cached !== undefined && cached.MoveID === moveID &&
            cached.Origin[0] === origin[0] && cached.Origin[1] === origin[1] && cached.Origin[2] === origin[2])
            return cached.Frames;
        const frames: StadiumMoveEffectParticleSnapshot[] = [];
        const state = new StadiumMoveEffectParticleState(spawn, particleIndex, emissionIndex);
        for (let frame = 0; frame < moveEffectPreviewFrames && state.alive; frame++) {
            // Several callbacks use the world-space attachment height for
            // ground collision even though snapshots expose local positions.
            state.setAttachmentOrigin(attachmentOrigin);
            this.callbackVM.runFrame(spawn.UpdateFunction, state, moveID);
            frames.push(state.snapshot());
        }
        particles[cacheIndex] = { MoveID: moveID, Origin: origin, Frames: frames };
        return frames;
    }

    public simulateModelTint(tint: MoveEffectModelTint, moveID: number): StadiumMoveEffectParticleSnapshot[] {
        let spawn = this.modelTintSpawns.get(tint);
        if (spawn === undefined) {
            const [a6, aa, cc, cd, cf, ce] = tint.Arguments;
            spawn = {
                Delay: tint.Delay, Interval: 0, Mode: 1, BurstCount: 1, UpdateFunction: tint.UpdateFunction,
                ParticleStyle: -1, ModelResources: [], ModelAnimationFrameCount: 0, Arguments: [...tint.Arguments], InitialState: { A6: a6, AA: aa, CC: cc, CD: cd, CF: cf, CE: ce },
                PaletteIndices: [], PrimitiveColorIndices: [], EnvironmentColorIndices: [], BehaviorCalls: [],
            };
            this.modelTintSpawns.set(tint, spawn);
        }
        return this.simulateParticle(spawn, 0, moveID);
    }
}
