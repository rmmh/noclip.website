import { PokemonAnimation } from './archive.js';
import { MoveEffectResolver } from './effects.js';
import { moveEffectEmissionCount, moveEffectFirstEmissionFrame } from './move_effect_timing.js';
import { SelectedPokemonAnimation } from './model_pose.js';

export interface PokemonAnimationControllerConfig {
    Animations: PokemonAnimation[];
    MoveAnimationIDs: number[];
    MoveAnimationFrequencies: number[];
    MoveEffectStartFrames: number[];
    NaturalMoveIDs: number[];
    LegalMoveIDs: number[];
    MoveEffectResolver: MoveEffectResolver;
}

export class PokemonAnimationController {
    private naturalMoveIDSet: Set<number>;
    private visibleAttackerMoveByAnimation = new Map<number, number>();

    constructor(private config: PokemonAnimationControllerConfig) {
        this.naturalMoveIDSet = new Set(config.NaturalMoveIDs);
    }

    public findVisibleAttackerMove(animationID: number): number {
        const cached = this.visibleAttackerMoveByAnimation.get(animationID);
        if (cached !== undefined) return cached;
        let moveID = -1;
        const fallbackMoves = this.config.LegalMoveIDs.filter((id) => !this.naturalMoveIDSet.has(id));
        for (const pool of [this.config.NaturalMoveIDs, fallbackMoves]) {
            let bestFrequency = -1;
            for (const candidate of pool) {
                const moveIndex = candidate - 1;
                if (this.config.MoveAnimationIDs[moveIndex] !== animationID) continue;
                const resolved = this.config.MoveEffectResolver.resolve(candidate);
                const visible = [...resolved.AttackerSetup, ...resolved.AttackerAction, ...resolved.TargetAction].some((primitive) =>
                    primitive.ParticleSpawns.length !== 0 || primitive.ModelTints.length !== 0 || primitive.CustomLifecycle !== null);
                if (!visible) continue;
                const frequency = this.config.MoveAnimationFrequencies[moveIndex] ?? 0;
                if (frequency > bestFrequency) { bestFrequency = frequency; moveID = candidate; }
            }
            if (moveID >= 0) break;
        }
        this.visibleAttackerMoveByAnimation.set(animationID, moveID);
        return moveID;
    }

    public select(time: number, selectedMove: number): SelectedPokemonAnimation | null {
        const animations = this.config.Animations;
        if (animations.length === 0) return null;
        const duration = (animation: PokemonAnimation): number => animation.FrameCount - animation.StartFrame;
        if (selectedMove > 0) {
            const index = this.config.MoveAnimationIDs[selectedMove - 1];
            const animation = animations[index];
            if (animation !== undefined) {
                const clipFrames = duration(animation);
                const activeFrames = Math.max(clipFrames, 60, this.getMovePreviewFrameCount(selectedMove));
                const elapsed = Math.floor(time * 30 / 1000) % activeFrames;
                return this.selectFrame(animation, index, elapsed, clipFrames);
            }
        }
        const previewDuration = (animation: PokemonAnimation, index: number): number =>
            Math.max(duration(animation), this.findVisibleAttackerMove(index) >= 0 ? 60 : 0);
        const allAnimationIndices = animations.map((_, index) => index);
        const preferredMoves = [...this.config.NaturalMoveIDs,
            ...this.config.LegalMoveIDs.filter((moveID) => !this.naturalMoveIDSet.has(moveID))];
        const legalAnimationIndices = [...new Set(preferredMoves.map((moveID) => this.config.MoveAnimationIDs[moveID - 1]))]
            .filter((index) => index !== undefined && animations[index] !== undefined);
        const animationIndices = selectedMove === 0 && legalAnimationIndices.length !== 0 ?
            legalAnimationIndices : allAnimationIndices;
        const totalFrames = animationIndices.reduce((n, index) => n + previewDuration(animations[index], index), 0);
        let cursor = Math.floor(time * 30 / 1000) % totalFrames;
        for (const index of animationIndices) {
            const animation = animations[index];
            const clipFrames = duration(animation);
            const activeFrames = previewDuration(animation, index);
            if (cursor < activeFrames) return this.selectFrame(animation, index, cursor, clipFrames);
            cursor -= activeFrames;
        }
        return null;
    }

    private getMovePreviewFrameCount(moveID: number): number {
        const resolved = this.config.MoveEffectResolver.resolve(moveID);
        let effectFrames = 0;
        for (const primitive of [...resolved.AttackerSetup, ...resolved.AttackerAction, ...resolved.TargetAction]) {
            for (const spawn of primitive.ParticleSpawns) {
                if (spawn.ModelAnimationFrameCount <= 0) continue;
                const emissions = moveEffectEmissionCount(spawn);
                if (emissions === 0) continue;
                const lastEmission = moveEffectFirstEmissionFrame(spawn) + (emissions - 1) * Math.max(1, spawn.Interval);
                effectFrames = Math.max(effectFrames, lastEmission + spawn.ModelAnimationFrameCount);
            }
        }
        return (this.config.MoveEffectStartFrames[moveID - 1] ?? 0) + 1 + effectFrames;
    }

    private selectFrame(animation: PokemonAnimation, index: number, elapsed: number,
                        clipFrames: number): SelectedPokemonAnimation {
        const animationElapsed = animation.LoopFrame >= animation.StartFrame && animation.LoopFrame < animation.FrameCount ?
            elapsed < clipFrames ? elapsed : animation.LoopFrame - animation.StartFrame +
                (elapsed - (animation.LoopFrame - animation.StartFrame)) % (animation.FrameCount - animation.LoopFrame) :
            Math.min(elapsed, clipFrames - 1);
        return { animation, index, frame: animation.StartFrame + animationElapsed, elapsed };
    }
}
