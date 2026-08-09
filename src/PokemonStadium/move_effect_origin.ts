import { mat4, vec3 } from 'gl-matrix';
import { MoveEffectParticleSpawn } from './effects.js';
import { PokemonModelPose } from './model_pose.js';

export interface MoveEffectOriginContext {
    ModelMatrix: mat4;
    ModelSize: vec3;
    ModelPose: PokemonModelPose;
}

/** Reproduce fragment62's attacker/target move-particle origin switch. */
export function getMoveEffectParticleOrigin(context: MoveEffectOriginContext, spawn: MoveEffectParticleSpawn,
                                            target: boolean, dst: vec3): vec3 {
    const channel = spawn.InitialState.CC;
    const attachmentID = spawn.InitialState.CD;
    const base = vec3.fromValues(context.ModelMatrix[12], context.ModelMatrix[13], context.ModelMatrix[14]);
    const attachment = (id: number): void => {
        if (context.ModelPose.getAttachmentPosition(id, dst)) return;
        // get_battle_actor_attachment_position treats 0x64 specially: it first
        // requests joint 0x0A, then joint 0x64. Other missing joints fall back
        // directly to 0x64.
        if (id === 0x64 && context.ModelPose.getAttachmentPosition(0x0A, dst)) return;
        if (id !== 0x64 && context.ModelPose.getAttachmentPosition(0x64, dst)) return;
        vec3.copy(dst, base);
    };
    const top = (): void => {
        vec3.copy(dst, base);
        dst[1] += context.ModelSize[1];
    };
    const radial = (reverse: boolean): void => {
        const sign = (target ? -1 : 1) * (reverse ? -1 : 1);
        dst[2] += context.ModelSize[0] * sign;
    };

    switch (channel) {
    case 0: vec3.copy(dst, base); break;
    case 1: top(); break;
    case 27: top(); dst[1] = 0; break;
    case 2: case 9: attachment(0x64); break;
    case 3: case 10: attachment(0x64); dst[1] = 0; break;
    case 4: case 11: attachment(0x64); radial(false); break;
    case 5: case 12: attachment(0x64); radial(true); break;
    case 6: case 13: attachment(0x64); dst[1] += context.ModelSize[1]; break;
    case 7: case 14: attachment(0x64); dst[1] = Math.max(0, dst[1] - context.ModelSize[1]); break;
    case 8: case 15: attachment(0x64); radial(false); dst[1] = 0; break;
    case 16: case 17: case 18: attachment(attachmentID); break;
    case 19: attachment(attachmentID); radial(false); break;
    case 29: case 30: vec3.copy(dst, base); dst[1] += 2.5; break;
    default: vec3.copy(dst, base); break;
    }
    return dst;
}
