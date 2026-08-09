import { MoveEffectParticleBehaviorCall, MoveEffectParticleSpawn, moveEffectColorPairs, moveEffectColors } from './effects.js';
import { bitsToFloat, particleAddress, primaryColorIndices, randomColorIndices, secondaryColorIndices, sign16 } from './move_effect_vm_shared.js';

export interface StadiumMoveEffectParticleSnapshot {
    Alive: boolean;
    Scale: number;
    Alpha: number;
    TextureFrame: number;
    ModelAnimationFrame: number;
    Rotation: readonly [number, number, number];
    /** Particle-local translation (spawn/attachment origin is applied by the scene). */
    Position: readonly [number, number, number];
    /** load_particle_2d_modelview's dedicated 2D translation, separate from world position. */
    ScreenPosition: readonly [number, number];
    PrimitiveColor: readonly [number, number, number, number];
    EnvironmentColor: readonly [number, number, number];
    ModelTintAmount: number;
    Calls: readonly MoveEffectParticleBehaviorCall[];
}
/** Runtime state for fragment34's particle-pool entry structure. */
export class StadiumMoveEffectParticleState {
    public readonly data = new DataView(new ArrayBuffer(0xD4));
    public alive = true;
    public calls: MoveEffectParticleBehaviorCall[] = [];
    public readonly unimplementedFunctions = new Set<number>();
    private randomState: number;
    private modelAnimationFrame = 0;
    private simulatedFrames = 0;
    private readonly modelAnimationFrameCount: number;
    private modelAnimationReverse: boolean;

    constructor(spawn: MoveEffectParticleSpawn, particleIndex: number, emissionIndex = 0) {
        this.modelAnimationFrameCount = spawn.ModelAnimationFrameCount ?? 0;
        this.modelAnimationReverse = spawn.ModelResources?.[0]?.Reverse ?? false;
        if (this.modelAnimationReverse && this.modelAnimationFrameCount > 0)
            this.modelAnimationFrame = this.modelAnimationFrameCount - 1;
        this.randomState = (0x6D2B79F5 ^ Math.imul(spawn.UpdateFunction, 33) ^ Math.imul(particleIndex + 1, 0x9E3779B1) ^
            Math.imul(emissionIndex, 0x85EBCA6B)) >>> 0;
        this.setS16(0xAC, particleIndex);
        this.setS16(0xA6, spawn.InitialState.A6);
        this.setS16(0xAA, spawn.InitialState.AA);
        this.setU8(0xCC, spawn.InitialState.CC);
        this.setU8(0xCD, spawn.InitialState.CD);
        this.setU8(0xCF, spawn.InitialState.CF);
        this.setU8(0xCE, spawn.InitialState.CE);
        this.setS16(0xB2, 1);
        this.setF32(0x1C, 1);
        this.setF32(0x28, 1);
        this.setU8(0xBE, 0xFF); this.setU8(0xBF, 0xFF); this.setU8(0xC0, 0xFF);
        this.setU8(0xC1, 0xFF); this.setU8(0xC2, 0xFF); this.setU8(0xC3, 0xFF);
        this.setU8(0xC4, 0xFF);
    }

    public getU8(offset: number): number { return this.data.getUint8(offset); }
    public setU8(offset: number, value: number): void { this.data.setUint8(offset, value); }
    public getS16(offset: number): number { return this.data.getInt16(offset); }
    public setS16(offset: number, value: number): void { this.data.setInt16(offset, value); }
    public getU32(offset: number): number { return this.data.getUint32(offset); }
    public setU32(offset: number, value: number): void { this.data.setUint32(offset, value); }
    public getF32(offset: number): number { return this.data.getFloat32(offset); }
    public setF32(offset: number, value: number): void { this.data.setFloat32(offset, value); }

    /** The attacker/target particle-origin updates refresh unk_68 before the callback. */
    public setAttachmentOrigin(origin: ArrayLike<number>): void {
        this.setF32(0x68, origin[0]); this.setF32(0x6C, origin[1]); this.setF32(0x70, origin[2]);
    }

    public snapshot(): StadiumMoveEffectParticleSnapshot {
        return {
            Alive: this.alive,
            Scale: this.getF32(0x1C), Alpha: this.getU8(0xC4), TextureFrame: this.getU8(0xC7),
            ModelAnimationFrame: this.modelAnimationFrame,
            Rotation: [this.getS16(0x94), this.getS16(0x96), this.getS16(0x98)],
            Position: [
                this.getF32(0x38) + this.getF32(0x50),
                this.getF32(0x3C) + this.getF32(0x54),
                this.getF32(0x40) + this.getF32(0x58),
            ],
            ScreenPosition: [this.getF32(0x2C), this.getF32(0x30)],
            PrimitiveColor: [this.getU8(0xBE), this.getU8(0xBF), this.getU8(0xC0), this.getU8(0xC4)],
            EnvironmentColor: [this.getU8(0xC1), this.getU8(0xC2), this.getU8(0xC3)],
            // Most model-tint callbacks pass unk_AE to PokemonModel_SetTintColor. The
            // update_cycling_model_tint instead passes prim_a;
            // callers select snapshot.Alpha for that one callback.
            ModelTintAmount: this.getS16(0xAE),
            Calls: this.calls.map((call) => ({ Function: call.Function, Arguments: [...call.Arguments] })),
        };
    }

    /** The model subsystem advances its animation once before each update after the spawn frame. */
    public beginEngineFrame(): void {
        if (this.simulatedFrames++ > 0 && this.modelAnimationFrameCount > 0) {
            if (this.modelAnimationReverse) this.modelAnimationFrame = Math.max(0, this.modelAnimationFrame - 1);
            else this.modelAnimationFrame = Math.min(this.modelAnimationFrame + 1, this.modelAnimationFrameCount - 1);
        }
    }

    public isModelAnimationAtStart(): boolean { return this.modelAnimationFrame <= 0; }

    private setFlag(mask: number): void { this.setU32(0x18, this.getU32(0x18) | mask); }
    private clearFlag(mask: number): void { this.setU32(0x18, this.getU32(0x18) & ~mask); }
    private hasFlag(mask: number): boolean { return (this.getU32(0x18) & mask) !== 0; }
    private advancePhase(): void { this.clearFlag(1); this.setS16(0xB2, this.getS16(0xB2) + 1); }
    private random(range: number): number {
        if (range <= 0) return 0;
        let value = this.randomState;
        value ^= value << 13; value ^= value >>> 17; value ^= value << 5;
        this.randomState = value >>> 0;
        return Math.floor(this.randomState / 10) % range;
    }
    private stepFloat(offset: number, target: number, step: number): boolean {
        const value = this.getF32(offset);
        if (value < target) this.setF32(offset, Math.min(target, value + Math.abs(step)));
        else this.setF32(offset, Math.max(target, value - Math.abs(step)));
        return this.getF32(offset) === target;
    }
    private stepByte(offset: number, target: number, step: number): boolean {
        const value = this.getU8(offset);
        this.setU8(offset, value < target ? Math.min(target, value + step) : Math.max(target, value - step));
        return this.getU8(offset) === target;
    }
    private animateTexture(first: number, last: number, delta: number, delay: number, repeats: number, reverse: boolean): boolean {
        if (!this.hasFlag(1)) {
            this.setS16(0xB6, delay); this.setU8(0xC7, first); this.setU8(0xC6, repeats); this.setFlag(1);
            return false;
        }
        const timer = this.getS16(0xB6) - 1;
        this.setS16(0xB6, timer);
        if (timer > 0) return false;
        this.setS16(0xB6, delay);
        const frame = this.getU8(0xC7) + (reverse ? -delta : delta);
        const passedEnd = reverse ? frame < last : frame > last;
        if (!passedEnd) { this.setU8(0xC7, frame); return false; }
        let remaining = this.getU8(0xC6);
        if (remaining > 0) remaining--;
        this.setU8(0xC6, remaining);
        if (remaining === 0) { this.setU8(0xC7, last); return true; }
        this.setU8(0xC7, first);
        return false;
    }

    private angleSin(angle: number): number { return Math.sin((angle << 16 >> 16) * Math.PI / 0x8000); }
    private angleCos(angle: number): number { return Math.cos((angle << 16 >> 16) * Math.PI / 0x8000); }
    private addPositionFromVelocity(x = true, y = true, z = true): void {
        if (x) this.setF32(0x50, this.getF32(0x50) + this.getF32(0x7C));
        if (y) this.setF32(0x54, this.getF32(0x54) + this.getF32(0x80));
        if (z) this.setF32(0x58, this.getF32(0x58) + this.getF32(0x84));
    }
    private calculateSphericalVelocity(): void {
        const speed = this.getF32(0x74), pitch = this.getS16(0x94), yaw = this.getS16(0x96);
        this.setF32(0x7C, speed * this.angleCos(pitch) * this.angleSin(yaw));
        this.setF32(0x80, -speed * this.angleSin(pitch));
        this.setF32(0x84, speed * this.angleCos(pitch) * this.angleCos(yaw));
    }
    private orientedVector(distance: number): [number, number, number] {
        const sx = this.angleSin(this.getS16(0x94)), cx = this.angleCos(this.getS16(0x94));
        const sy = this.angleSin(this.getS16(0x96)), cy = this.angleCos(this.getS16(0x96));
        const sz = this.angleSin(this.getS16(0x98)), cz = this.angleCos(this.getS16(0x98));
        return [distance * (sx * cy * sz + cx * sy), -distance * sx * cz, distance * (-sx * sy * sz + cx * cy)];
    }
    private setPrimitiveColor(index: number): void {
        const color = moveEffectColors[index]; if (color === undefined) return;
        this.setU8(0xBE, color[0]); this.setU8(0xBF, color[1]); this.setU8(0xC0, color[2]);
    }
    private setEnvironmentColor(index: number): void {
        const color = moveEffectColors[index]; if (color === undefined) return;
        this.setU8(0xC1, color[0]); this.setU8(0xC2, color[1]); this.setU8(0xC3, color[2]);
    }
    private stepAngle(offset: number, target: number, step: number): boolean {
        const current = this.getS16(offset);
        const next = current < target ? Math.min(target, current + Math.abs(step)) : Math.max(target, current - Math.abs(step));
        this.setS16(offset, next);
        return next === target;
    }

    /** Dispatch the fragment34 helpers that own particle state transitions. */
    public call(functionAddress: number, args: number[]): number {
        this.calls.push({ Function: functionAddress, Arguments: args.map((v) => v | 0) });
        const a1 = args[1] | 0, a2 = args[2] | 0, a3 = args[3] | 0, a4 = args[4] | 0, a5 = args[5] | 0;
        switch (functionAddress >>> 0) {
        case 0x81400760: {
            const offset = (args[0] >>> 0) - particleAddress;
            if (offset < 0 || offset + 4 > this.data.byteLength) return 0;
            return this.stepFloat(offset, bitsToFloat(a1), bitsToFloat(a2)) ? 1 : 0;
        }
        case 0x81400A78: return this.random(args[0] | 0);
        case 0x81400ADC: return this.random(args[0] | 0) + (args[1] | 0);
        case 0x81400B00: return this.random((args[0] | 0) * 2) - (args[0] | 0);
        case 0x81400B28: return this.random((args[0] | 0) * 2) - (args[0] | 0) + a1;
        case 0x81400B4C: { const v = this.random((args[0] | 0) * 2) - (args[0] | 0); return v < 0 ? v - a1 : v + a1; }
        case 0x814011E0: {
            // O32 passes the two Vec3f values as six consecutive words.
            const x0 = bitsToFloat(args[0]), z0 = bitsToFloat(args[2]);
            const x1 = bitsToFloat(args[3]), z1 = bitsToFloat(args[5]);
            // Stadium angles are zero along +Z and +0x4000 along +X.
            return sign16(Math.round(Math.atan2(x1 - x0, z1 - z0) * 0x8000 / Math.PI));
        }
        case 0x81408150:
        case 0x81408158: this.setS16(0xB2, 0); this.alive = false; return 0;
        case 0x81408180: return this.getS16(0xB2) === 0 ? 1 : 0;
        case 0x8140819C: return this.getS16(0xB2) >= 2 ? 1 : 0;
        case 0x814081BC: this.advancePhase(); return 0;
        case 0x8140826C: {
            if (!this.hasFlag(0x80)) { this.setFlag(0x80); this.setS16(0xBC, a1); }
            this.setS16(0xBC, this.getS16(0xBC) - 1);
            if (this.getS16(0xBC) <= 0) { this.setS16(0xBC, 0); this.clearFlag(0x80); this.advancePhase(); return 1; }
            return 0;
        }
        case 0x814082B4: this.setFlag(a1); return 0;
        case 0x814082C4: this.clearFlag(a1); return 0;
        case 0x814082D8: this.setU32(0x18, this.getU32(0x18) ^ a1); return 0;
        case 0x814082E8: return this.hasFlag(a1) ? 1 : 0;
        case 0x81408308: return this.hasFlag(a1) ? 0 : 1;
        case 0x81408328: this.setFlag(4); return 0;
        case 0x81408348: this.clearFlag(4); return 0;
        case 0x81408368: return this.hasFlag(4) ? 1 : 0;
        case 0x81408A1C: this.setS16(0xB8, 1); this.clearFlag(2); return 0;
        case 0x81408A68: this.setS16(0xB8, this.getS16(0xB8) + 1); return 0;
        case 0x81408A78:
            if (!this.hasFlag(2)) { this.setFlag(2); this.setS16(0xBA, a1); }
            this.setS16(0xBA, this.getS16(0xBA) - 1);
            if (this.getS16(0xBA) < 0) { this.clearFlag(2); return 1; } return 0;
        // Position and motion helpers from fragment34. gParticleRenderContext.unk_00.y is
        // one during the battle update used by these callbacks.
        case 0x81408AF0:
            this.setF32(0x2C, this.getF32(0x68) + this.getF32(0x38) + this.getF32(0x50));
            this.setF32(0x30, this.getF32(0x6C) + this.getF32(0x3C) + this.getF32(0x54));
            this.setF32(0x34, this.getF32(0x70) + this.getF32(0x40) + this.getF32(0x58));
            return 0;
        case 0x81408BE0:
            this.setF32(0x38, bitsToFloat(a1)); this.setF32(0x3C, bitsToFloat(a2)); this.setF32(0x40, bitsToFloat(a3)); return 0;
        case 0x81408C68:
            this.setF32(0x38, bitsToFloat(a1)); this.setF32(0x3C, bitsToFloat(a2)); this.setF32(0x40, bitsToFloat(a3)); return 0;
        case 0x81408C88: this.setF32(0x38, bitsToFloat(a1)); return 0;
        case 0x81408CA0: this.setF32(0x3C, bitsToFloat(a1)); return 0;
        case 0x81408CD0: {
            const v = this.orientedVector(bitsToFloat(a1)); this.setF32(0x38, v[0]); this.setF32(0x3C, v[1]); this.setF32(0x40, v[2]); return 0;
        }
        case 0x81408D78:
            this.setF32(0x38, this.getF32(0x38) + bitsToFloat(a1));
            this.setF32(0x3C, this.getF32(0x3C) + bitsToFloat(a2));
            this.setF32(0x40, this.getF32(0x40) + bitsToFloat(a3)); return 0;
        case 0x81408E18:
            this.setF32(0x38, this.getF32(0x38) + bitsToFloat(a1));
            this.setF32(0x3C, this.getF32(0x3C) + bitsToFloat(a2));
            this.setF32(0x40, this.getF32(0x40) + bitsToFloat(a3)); return 0;
        case 0x81408E70: this.setF32(0x38, this.getF32(0x38) + bitsToFloat(a1)); return 0;
        case 0x81408E90: this.setF32(0x3C, this.getF32(0x3C) + bitsToFloat(a1)); return 0;
        case 0x81408EB0: this.setF32(0x40, this.getF32(0x40) + bitsToFloat(a1)); return 0;
        case 0x81408ED0: {
            const distance = bitsToFloat(a1), yaw = this.getS16(0x96);
            this.setF32(0x38, this.getF32(0x38) + distance * this.angleSin(yaw));
            this.setF32(0x40, this.getF32(0x40) + distance * this.angleCos(yaw)); return 0;
        }
        case 0x81408F38:
        case 0x81408FAC: {
            const distance = bitsToFloat(a1), yaw = this.getS16(0x96) + (functionAddress === 0x81408F38 ? 0x8000 : 0x4000);
            this.setF32(0x38, this.getF32(0x38) + distance * this.angleSin(yaw));
            this.setF32(0x40, this.getF32(0x40) + distance * this.angleCos(yaw)); return 0;
        }
        case 0x8140908C: {
            const distance = bitsToFloat(a1), yaw = this.getS16(0x96);
            this.setF32(0x38, this.getF32(0x38) + distance * this.angleSin(yaw));
            this.setF32(0x40, this.getF32(0x40) + distance * this.angleCos(yaw)); return 0;
        }
        case 0x8140910C: {
            const v = this.orientedVector(bitsToFloat(a1));
            this.setF32(0x38, this.getF32(0x38) + v[0]); this.setF32(0x3C, this.getF32(0x3C) + v[1]);
            this.setF32(0x40, this.getF32(0x40) + v[2]); return 0;
        }
        case 0x814091B4: {
            // func_81400D00 rotates the by-value Vec3f around particle yaw.
            const x = bitsToFloat(a1), y = bitsToFloat(a2), z = bitsToFloat(a3);
            const sin = this.angleSin(this.getS16(0x96)), cos = this.angleCos(this.getS16(0x96));
            this.setF32(0x38, this.getF32(0x38) + x * cos + z * sin);
            this.setF32(0x3C, this.getF32(0x3C) + y);
            this.setF32(0x40, this.getF32(0x40) - x * sin + z * cos); return 0;
        }
        case 0x81409248: this.setF32(0x38, this.random(a1 * 2) - a1); return 0;
        case 0x814092C8: this.setF32(0x40, this.random(a1 * 2) - a1); return 0;
        case 0x8140935C: this.setF32(0x3C, this.random(a1 * 2) - a1 + a2); return 0;
        case 0x81409404:
        case 0x81409514: {
            const value = this.random(a1 * 2) - a1, result = value < 0 ? value - a2 : value + a2;
            this.setF32(functionAddress === 0x81409404 ? 0x38 : 0x40, result); return 0;
        }
        case 0x8140959C:
            this.setF32(0x38, this.random(a1 * 2) - a1);
            this.setF32(0x3C, this.random(a2 * 2) - a2);
            this.setF32(0x40, this.random(a3 * 2) - a3); return 0;
        case 0x814099C0: this.setF32(0x50, this.getF32(0x50) + bitsToFloat(a1)); return 0;
        case 0x81409900: this.setF32(0x54, bitsToFloat(a1)); return 0;
        case 0x814099E0: this.setF32(0x54, this.getF32(0x54) + bitsToFloat(a1)); return 0;
        case 0x81409A00: this.setF32(0x58, this.getF32(0x58) + bitsToFloat(a1)); return 0;
        case 0x81409BDC: this.addPositionFromVelocity(); return 0;
        case 0x81409C10: this.addPositionFromVelocity(true, false, true); return 0;
        case 0x81409C34: this.addPositionFromVelocity(true, true, false); return 0;
        case 0x81409C58: this.addPositionFromVelocity(true, false, false); return 0;
        case 0x81409C6C: this.addPositionFromVelocity(false, true, false); return 0;
        case 0x81409C80: this.addPositionFromVelocity(false, false, true); return 0;
        case 0x81409CBC: {
            const speed = this.getF32(0x74), yaw = this.getS16(0x96);
            this.setF32(0x7C, speed * this.angleSin(yaw)); this.setF32(0x84, speed * this.angleCos(yaw));
            this.addPositionFromVelocity(true, false, true); return 0;
        }
        case 0x81409D0C: this.calculateSphericalVelocity(); this.addPositionFromVelocity(); return 0;
        case 0x81409D5C: {
            const speed = this.getF32(0x74), pitch = this.getS16(0x94), yaw = this.getS16(0x96);
            this.setF32(0x7C, speed * this.angleSin(yaw));
            this.setF32(0x80, -speed * this.angleSin(pitch) * this.angleCos(yaw));
            this.setF32(0x84, speed * this.angleCos(pitch) * this.angleCos(yaw)); this.addPositionFromVelocity(); return 0;
        }
        case 0x81409DAC: {
            const v = this.orientedVector(this.getF32(0x74)); this.setF32(0x7C, v[0]); this.setF32(0x80, v[1]); this.setF32(0x84, v[2]);
            this.addPositionFromVelocity(); return 0;
        }
        case 0x81409E4C: {
            const speed = this.getF32(0x74), yaw = this.getS16(0x96);
            this.setF32(0x7C, speed * this.angleSin(yaw)); this.setF32(0x84, speed * this.angleCos(yaw));
            this.addPositionFromVelocity(true, false, true); return 0;
        }
        case 0x81409EA0: {
            const speed = this.getF32(0x74), yaw = this.getS16(0x96) + 0x8000;
            this.setF32(0x7C, speed * this.angleSin(yaw)); this.setF32(0x84, speed * this.angleCos(yaw));
            this.addPositionFromVelocity(true, false, true); return 0;
        }
        case 0x81409F00: {
            const speed = bitsToFloat(a1), yaw = this.getS16(0x96) + 0x8000;
            this.setF32(0x7C, speed * this.angleSin(yaw)); this.setF32(0x84, speed * this.angleCos(yaw));
            this.addPositionFromVelocity(true, false, true); return 0;
        }
        case 0x81409F60: this.setF32(0x80, this.getF32(0x74)); this.addPositionFromVelocity(false, true, false); return 0;
        case 0x81409F84:
            this.setF32(0x80, -this.getF32(0x74)); this.addPositionFromVelocity(false, true, false);
            return this.getF32(0x30) <= 0 ? 1 : 0;
        case 0x81409FD8:
            this.setF32(0x74, this.getF32(0x74) + this.getF32(0x78));
            this.setF32(0x80, -this.getF32(0x74)); this.addPositionFromVelocity(false, true, false);
            return this.getF32(0x30) <= 0 ? 1 : 0;
        case 0x814083E8: this.setU8(0xC7, a1); return 0;
        case 0x814083FC: return this.animateTexture(a1, a2, a3, a4, a5, false) ? 1 : 0;
        case 0x814084D8: {
            const done = this.animateTexture(a1, a2, a3, a4, a5, false);
            if (done) this.advancePhase();
            return done ? 1 : 0;
        }
        case 0x81408548: return this.animateTexture(a1, a2, a3, a4, a5, true) ? 1 : 0;
        case 0x81408624: {
            const done = this.animateTexture(a1, a2, a3, a4, a5, true);
            if (done) this.advancePhase();
            return done ? 1 : 0;
        }
        case 0x8140BCA8: this.setS16(0xA6, a1); return 0;
        case 0x8140BCBC: return this.getS16(0xA6);
        case 0x8140BD08: {
            const value = Math.max(0, this.getS16(0xA6) - a1); this.setS16(0xA6, value); return value === 0 ? 1 : 0;
        }
        case 0x8140BD34: {
            const value = Math.max(0, this.getS16(0xA6) - a1); this.setS16(0xA6, value);
            if (value === 0) this.advancePhase();
            return value === 0 ? 1 : 0;
        }
        case 0x8140BD80: {
            const value = Math.max(a1, this.getS16(0xA6) - 1); this.setS16(0xA6, value); return value === a1 ? 1 : 0;
        }
        case 0x8140BDAC: {
            const value = Math.max(0, this.getS16(0xA6) - 1); this.setS16(0xA6, value); return value === 0 ? 1 : 0;
        }
        case 0x8140BDD0: {
            const countdown = Math.max(0, this.getS16(0xA6) - 1);
            this.setS16(0xA6, countdown);
            if (countdown === 0) { this.advancePhase(); return 1; }
            return 0;
        }
        case 0x8140C038: return this.getS16(0xAC);
        case 0x8140C040: return this.getU8(0xCE);
        case 0x8140C048: return this.getU8(0xCD);
        case 0x8140C050: return this.getS16(0xAE);
        case 0x8140C058: return this.getU8(0xCF);
        case 0x8140C068: return this.getS16(0xAA);
        case 0x8140B938: this.setF32(0x1C, bitsToFloat(a1)); return 0;
        case 0x8140B950: this.setF32(0x1C, bitsToFloat(a1)); return 0;
        case 0x8140B95C: this.setF32(0x20, bitsToFloat(a1)); return 0;
        case 0x8140B974: this.setF32(0x24, bitsToFloat(a1)); return 0;
        case 0x8140B98C: return this.stepFloat(0x1C, bitsToFloat(a1), bitsToFloat(a2)) ? 1 : 0;
        case 0x8140B9D0: {
            const done = this.stepFloat(0x1C, bitsToFloat(a1), bitsToFloat(a2));
            if (done) this.advancePhase();
            return done ? 1 : 0;
        }
        case 0x8140BA1C: return this.stepFloat(0x1C, this.getF32(0x20), this.getF32(0x24)) ? 1 : 0;
        case 0x8140BA48: {
            const done = this.stepFloat(0x1C, this.getF32(0x20), this.getF32(0x24));
            if (done) this.advancePhase();
            return done ? 1 : 0;
        }
        case 0x8140BAC8: this.setU8(0xBE, a1); this.setU8(0xBF, a2); this.setU8(0xC0, a3); return 0;
        case 0x8140BAE4: return this.stepByte(0xBE, a1, a2) ? 1 : 0;
        case 0x8140BB14: return this.stepByte(0xBF, a1, a2) ? 1 : 0;
        case 0x8140BB44: return this.stepByte(0xC0, a1, a2) ? 1 : 0;
        case 0x8140BB74: this.setU8(0xC1, a1); this.setU8(0xC2, a2); this.setU8(0xC3, a3); return 0;
        case 0x8140BB90: return this.stepByte(0xC1, a1, a2) ? 1 : 0;
        case 0x8140BBC0: return this.stepByte(0xC3, a1, a2) ? 1 : 0;
        case 0x8140BBF0: return this.stepByte(0xC2, a1, a2) ? 1 : 0;
        case 0x8140BC20: this.setU8(0xC4, a1); return 0;
        case 0x8140BC2C: return this.stepByte(0xC4, a1, a2) ? 1 : 0;
        case 0x8140BC5C: {
            const done = this.stepByte(0xC4, a1, a2);
            if (done) this.advancePhase();
            return done ? 1 : 0;
        }
        case 0x8140AD8C: this.setF32(0x74, bitsToFloat(a1)); return 0;
        case 0x8140ADA4: this.setF32(0x78, bitsToFloat(a1)); return 0;
        case 0x8140ADBC: return this.stepFloat(0x74, bitsToFloat(a1), bitsToFloat(a2)) ? 1 : 0;
        case 0x8140AE40: return this.stepFloat(0x78, bitsToFloat(a1), bitsToFloat(a2)) ? 1 : 0;
        case 0x8140AF24: this.setF32(0x80, bitsToFloat(a1)); return 0;
        case 0x8140B0A4: {
            const terminal = bitsToFloat(a1), step = bitsToFloat(a2);
            const velocity = Math.max(terminal, this.getF32(0x80) - step); this.setF32(0x80, velocity);
            return velocity === terminal ? 1 : 0;
        }
        case 0x8140B2B4: this.calculateSphericalVelocity(); return 0;
        case 0x8140B180: return this.stepFloat(0x80, bitsToFloat(a1), bitsToFloat(a2)) ? 1 : 0;
        case 0x8140B7C8: {
            const previousX = this.getF32(0x50), previousZ = this.getF32(0x58);
            const angle = this.getS16(0x9C) + a2; this.setS16(0x9C, angle);
            const x = bitsToFloat(a1) * this.angleSin(angle), z = bitsToFloat(a1) * this.angleCos(angle);
            this.setF32(0x50, x); this.setF32(0x58, z); this.setF32(0x7C, x - previousX); this.setF32(0x84, z - previousZ); return 0;
        }
        case 0x8140A2A4: this.setS16(0x94, a1); return 0;
        case 0x8140A2B8: this.setS16(0x96, a1); return 0;
        case 0x8140A2CC: this.setS16(0x98, a1); return 0;
        case 0x8140A270:
            this.setS16(0x94, a1); this.setS16(0x96, a2); this.setS16(0x98, a3); return 0;
        case 0x8140A24C:
            this.setS16(0x94, sign16(a1 >>> 16)); this.setS16(0x96, sign16(a1)); this.setS16(0x98, sign16(a2 >>> 16)); return 0;
        case 0x8140A334: this.setS16(0x98, this.getS16(0x98) + 0x8000); return 0;
        case 0x8140A3A0: this.setS16(0x9A, a1); this.setS16(0x9C, a2); return 0;
        case 0x8140A3C4: this.setS16(0x9A, a1); return 0;
        case 0x8140A3D8: this.setS16(0x9C, a1); return 0;
        case 0x8140A3EC: this.setS16(0x9E, a1); return 0;
        case 0x8140A400: this.setS16(0xA0, a1); return 0;
        case 0x8140A414: this.setS16(0xA2, a1); return 0;
        case 0x8140A428: this.setS16(0xA0, a1); this.setS16(0xA2, a2); return 0;
        case 0x8140A4B4: this.setS16(0x94, this.getS16(0x94) + this.getS16(0x9A)); return 0;
        case 0x8140A4C8: this.setS16(0x96, this.getS16(0x96) + this.getS16(0x9C)); return 0;
        case 0x8140A4DC: this.setS16(0x98, this.getS16(0x98) + this.getS16(0x9E)); return 0;
        case 0x8140A4F0:
            // O32 passes Vec3s by value in two words: x/y, then z/padding.
            this.setS16(0x94, this.getS16(0x94) + sign16(a1 >>> 16));
            this.setS16(0x96, this.getS16(0x96) + sign16(a1));
            this.setS16(0x98, this.getS16(0x98) + sign16(a2 >>> 16)); return 0;
        case 0x8140A52C:
            this.setS16(0x94, this.getS16(0x94) + a1); this.setS16(0x96, this.getS16(0x96) + a2);
            this.setS16(0x98, this.getS16(0x98) + a3); return 0;
        case 0x8140A578: this.setS16(0x94, this.getS16(0x94) + a1); return 0;
        case 0x8140A594: this.setS16(0x96, this.getS16(0x96) + a1); return 0;
        case 0x8140A5B0: this.setS16(0x98, this.getS16(0x98) + a1); return 0;
        case 0x8140A5CC: this.setS16(0xA0, this.getS16(0xA0) + a1); this.setS16(0xA2, this.getS16(0xA2) + a2); return 0;
        case 0x8140A690: this.stepAngle(0x94, this.getS16(0xA0), this.getS16(0x9A)); return 0;
        case 0x8140A6BC: this.stepAngle(0x96, this.getS16(0xA2), this.getS16(0x9C)); return 0;
        case 0x8140A76C: return this.stepAngle(0x94, a1, a2) ? 1 : 0;
        case 0x8140A7DC: {
            const current = this.getS16(0x94); if (a1 >= current) return 0;
            const next = Math.max(a1, current - a2); this.setS16(0x94, next); return next === a1 ? 1 : 0;
        }
        case 0x8140BE14: this.setS16(0xA8, a1); return 0;
        case 0x8140BE6C: {
            const value = Math.max(0, this.getS16(0xA8) - 1); this.setS16(0xA8, value); return value === 0 ? 1 : 0;
        }
        case 0x8140BECC: this.setU8(0xCA, a1); return 0;
        case 0x8140BED8: this.setS16(0xAC, a1); return 0;
        case 0x8140BEEC:
        case 0x8140BEF8: this.setU8(0xCF, a1); return 0;
        case 0x8140BF04: this.setU8(0xCC, a1); return 0;
        case 0x8140BF60: return this.stepAngle(0xAE, a1, a2) ? 1 : 0;
        case 0x8140BF98: {
            const done = this.stepAngle(0xAE, a1, a2); if (done) this.advancePhase(); return done ? 1 : 0;
        }
        case 0x8140BF4C: this.setS16(0xAE, a1); return 0;
        case 0x8140BFEC: this.setS16(0xB0, a1); return 0;
        case 0x8140C000: return this.stepAngle(0xB0, a1, a2) ? 1 : 0;
        case 0x8140D530: this.setPrimitiveColor(a1); return 0;
        case 0x8140D568: this.setEnvironmentColor(a1); return 0;
        case 0x8140D5A0: {
            const pair = moveEffectColorPairs[a1]; if (pair !== undefined) { this.setPrimitiveColor(pair[0]); this.setEnvironmentColor(pair[1]); } return 0;
        }
        case 0x8140D624: this.setEnvironmentColor(primaryColorIndices[a1] ?? 0); return 0;
        case 0x8140D658: this.setPrimitiveColor(secondaryColorIndices[a1] ?? 0); return 0;
        case 0x8140D68C: this.setEnvironmentColor(secondaryColorIndices[a1] ?? 0); return 0;
        case 0x8140D78C: this.setEnvironmentColor(randomColorIndices[this.random(randomColorIndices.length)]); return 0;
        case 0x8140D7C8: {
            const color = moveEffectColors[a1]; if (color === undefined) return 0;
            const r = this.stepByte(0xBE, color[0], a2), g = this.stepByte(0xBF, color[1], a2), b = this.stepByte(0xC0, color[2], a2);
            return r && g && b ? 1 : 0;
        }
        case 0x8140D908: {
            const pair = moveEffectColorPairs[a1]; if (pair === undefined) return 0;
            const p = moveEffectColors[pair[0]], e = moveEffectColors[pair[1]];
            const results = [this.stepByte(0xBE, p[0], a2), this.stepByte(0xBF, p[1], a2), this.stepByte(0xC0, p[2], a2),
                this.stepByte(0xC1, e[0], a2), this.stepByte(0xC2, e[1], a2), this.stepByte(0xC3, e[2], a2)];
            return results.every(Boolean) ? 1 : 0;
        }
        // Engine/model hooks do not mutate the fragment34 particle structure.
        case 0x8000A360: case 0x8000A4D4: case 0x8000A4F8: case 0x80015390:
        case 0x800173DC:
            this.modelAnimationReverse = a3 < 0;
            this.modelAnimationFrame = this.modelAnimationReverse ? Math.max(0, this.modelAnimationFrameCount - 1) : 0;
            return 0;
        case 0x80017464:
            if (a1 >= 0) this.modelAnimationFrame = Math.min(a1, Math.max(0, this.modelAnimationFrameCount - 1));
            return 0;
        case 0x80017514: return this.modelAnimationFrameCount > 0 &&
            this.modelAnimationFrame >= this.modelAnimationFrameCount - 1 ? 1 : 0;
        case 0x8001BC34: case 0x8001BE34: case 0x8001BE78:
        case 0x81400930: case 0x8140094C: case 0x81407B3C: return 0;
        default: this.unimplementedFunctions.add(functionAddress >>> 0); return 0;
        }
    }
}
