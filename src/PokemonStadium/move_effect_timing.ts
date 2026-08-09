import { MoveEffectParticleSpawn } from './effects.js';
import { moveEffectPreviewFrames } from './move_effect_geometry.js';

/** update_move_effect_scheduler decrements the initial delay before testing it. */
export function moveEffectFirstEmissionFrame(spawn: MoveEffectParticleSpawn): number {
    return Math.max(0, spawn.Delay - 1);
}

/** Number of scheduler firings visible inside the bounded viewer preview. */
export function moveEffectEmissionCount(spawn: MoveEffectParticleSpawn): number {
    if (spawn.Mode !== -1 && spawn.Mode !== 0x7F) return Math.max(1, spawn.Mode);
    const first = moveEffectFirstEmissionFrame(spawn);
    if (first >= moveEffectPreviewFrames) return 0;
    return 1 + Math.floor((moveEffectPreviewFrames - 1 - first) / Math.max(1, spawn.Interval));
}
