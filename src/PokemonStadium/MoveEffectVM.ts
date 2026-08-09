import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { MoveEffectParticleBehaviorCall } from './effects.js';
import { StadiumMoveEffectParticleState } from './move_effect_particle_state.js';
import {
    bitsToFloat, floatToBits, fragment34ConstantByte, fragmentVirtualBase, particleAddress, relocatedFragmentBase,
    returnSentinel, sign16, stackAddress,
} from './move_effect_vm_shared.js';

export { StadiumMoveEffectParticleState } from './move_effect_particle_state.js';
export type { StadiumMoveEffectParticleSnapshot } from './move_effect_particle_state.js';

/**
 * Small MIPS-III interpreter for fragment62 particle callbacks. It executes
 * original control flow and fragment-local helpers, while fragment34 calls
 * are dispatched to StadiumMoveEffectParticleState above.
 */
export class StadiumMoveEffectCallbackVM {
    public readonly unimplementedInstructions = new Set<number>();
    private readonly code: DataView;
    private readonly stack = new DataView(new ArrayBuffer(0x1000));
    private readonly globals = new Map<number, number>();
    private readonly r = new Uint32Array(32);
    private readonly f = new Uint32Array(32);
    private hi = 0;
    private lo = 0;
    private fpCondition = false;
    /** fragment62's sCurrentMoveEffectId, read by get_current_move_effect_id(). */
    private currentMoveEffectID = 0;

    constructor(fragment: ArrayBufferSlice) { this.code = fragment.createDataView(); }

    private fragmentOffset(address: number): number | null {
        const top = (address & 0xFFF00000) >>> 0;
        if (top === fragmentVirtualBase || top === relocatedFragmentBase) return address & 0x000FFFFF;
        return null;
    }

    private canonicalCodeAddress(address: number): number {
        const offset = this.fragmentOffset(address);
        return offset === null ? address >>> 0 : (fragmentVirtualBase + offset) >>> 0;
    }

    private load(address: number, size: 1 | 2 | 4, signed = false, particle?: StadiumMoveEffectParticleState): number {
        if ((address >>> 0) === 0x843902AC && size === 4)
            return this.currentMoveEffectID >>> 0;
        const fragmentOffset = this.fragmentOffset(address);
        const view = fragmentOffset !== null ? this.code : address >= particleAddress && address < particleAddress + 0xD4 ? particle!.data :
            address >= stackAddress && address < stackAddress + this.stack.byteLength ? this.stack : null;
        const offset = fragmentOffset ?? (view === particle?.data ? address - particleAddress : address - stackAddress);
        if (view !== null) {
            if (size === 1) return signed ? view.getInt8(offset) : view.getUint8(offset);
            if (size === 2) return signed ? view.getInt16(offset) : view.getUint16(offset);
            return view.getUint32(offset);
        }
        const constantByte = fragment34ConstantByte(address >>> 0);
        if (size === 1 && constantByte !== undefined) return signed && constantByte >= 0x80 ? constantByte - 0x100 : constantByte;
        return this.globals.get(address >>> 0) ?? 0;
    }

    private store(address: number, size: 1 | 2 | 4, value: number, particle: StadiumMoveEffectParticleState): void {
        const view = address >= particleAddress && address < particleAddress + 0xD4 ? particle.data :
            address >= stackAddress && address < stackAddress + this.stack.byteLength ? this.stack : null;
        const offset = view === particle.data ? address - particleAddress : address - stackAddress;
        if (view !== null) {
            if (size === 1) view.setUint8(offset, value);
            else if (size === 2) view.setUint16(offset, value);
            else view.setUint32(offset, value);
        } else this.globals.set(address >>> 0, value >>> 0);
    }

    private callExternal(address: number, args: number[], particle: StadiumMoveEffectParticleState): number {
        if ((address >>> 0) === 0x8000E88C) {
            // Vec3f_Set is used to construct a by-value vector on the callback's stack.
            this.store(args[0], 4, args[1], particle);
            this.store(args[0] + 4, 4, args[2], particle);
            this.store(args[0] + 8, 4, args[3], particle);
            return args[0] >>> 0;
        }
        return particle.call(address, args);
    }

    private executeNonControl(instruction: number, particle: StadiumMoveEffectParticleState): void {
        const op = instruction >>> 26, rs = instruction >>> 21 & 31, rt = instruction >>> 16 & 31;
        const rd = instruction >>> 11 & 31, sa = instruction >>> 6 & 31, imm = sign16(instruction), uimm = instruction & 0xFFFF;
        const address = (this.r[rs] + imm) >>> 0;
        if (instruction === 0) return;
        const integerFunctions = [0, 2, 3, 4, 6, 7, 0x10, 0x11, 0x12, 0x13, 0x18, 0x19, 0x1A, 0x1B,
            0x21, 0x23, 0x24, 0x25, 0x26, 0x27, 0x2A, 0x2B];
        const ordinaryOpcodes = [0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25,
            0x26, 0x28, 0x29, 0x2A, 0x2B, 0x2E, 0x31, 0x35, 0x39, 0x3D];
        if (!(op === 0 ? integerFunctions.includes(instruction & 63) : ordinaryOpcodes.includes(op) || op === 0x11))
            this.unimplementedInstructions.add(instruction >>> 0);
        if (op === 0) {
            const fn = instruction & 63;
            if (fn === 0) this.r[rd] = this.r[rt] << sa;
            else if (fn === 2) this.r[rd] = this.r[rt] >>> sa;
            else if (fn === 3) this.r[rd] = this.r[rt] >> sa;
            else if (fn === 4) this.r[rd] = this.r[rt] << (this.r[rs] & 31);
            else if (fn === 6) this.r[rd] = this.r[rt] >>> (this.r[rs] & 31);
            else if (fn === 7) this.r[rd] = this.r[rt] >> (this.r[rs] & 31);
            else if (fn === 0x10) this.r[rd] = this.hi;
            else if (fn === 0x11) this.hi = this.r[rs];
            else if (fn === 0x12) this.r[rd] = this.lo;
            else if (fn === 0x13) this.lo = this.r[rs];
            else if (fn === 0x18 || fn === 0x19) {
                const lhs = fn === 0x18 ? BigInt(this.r[rs] | 0) : BigInt(this.r[rs]);
                const rhs = fn === 0x18 ? BigInt(this.r[rt] | 0) : BigInt(this.r[rt]);
                const product = BigInt.asUintN(64, lhs * rhs);
                this.lo = Number(product & 0xFFFFFFFFn); this.hi = Number(product >> 32n & 0xFFFFFFFFn);
            } else if (fn === 0x1A || fn === 0x1B) {
                const divisor = fn === 0x1A ? this.r[rt] | 0 : this.r[rt];
                if (divisor !== 0) {
                    const dividend = fn === 0x1A ? this.r[rs] | 0 : this.r[rs];
                    this.lo = Math.trunc(dividend / divisor) >>> 0; this.hi = (dividend % divisor) >>> 0;
                }
            }
            else if (fn === 0x21) this.r[rd] = (this.r[rs] + this.r[rt]) >>> 0;
            else if (fn === 0x23) this.r[rd] = (this.r[rs] - this.r[rt]) >>> 0;
            else if (fn === 0x24) this.r[rd] = this.r[rs] & this.r[rt];
            else if (fn === 0x25) this.r[rd] = this.r[rs] | this.r[rt];
            else if (fn === 0x26) this.r[rd] = this.r[rs] ^ this.r[rt];
            else if (fn === 0x27) this.r[rd] = ~(this.r[rs] | this.r[rt]);
            else if (fn === 0x2A) this.r[rd] = (this.r[rs] | 0) < (this.r[rt] | 0) ? 1 : 0;
            else if (fn === 0x2B) this.r[rd] = this.r[rs] < this.r[rt] ? 1 : 0;
        } else if (op === 0x09) this.r[rt] = (this.r[rs] + imm) >>> 0;
        else if (op === 0x0A) this.r[rt] = (this.r[rs] | 0) < imm ? 1 : 0;
        else if (op === 0x0B) this.r[rt] = this.r[rs] < (imm >>> 0) ? 1 : 0;
        else if (op === 0x0C) this.r[rt] = this.r[rs] & uimm;
        else if (op === 0x0D) this.r[rt] = this.r[rs] | uimm;
        else if (op === 0x0E) this.r[rt] = this.r[rs] ^ uimm;
        else if (op === 0x0F) this.r[rt] = uimm << 16;
        else if (op === 0x20) this.r[rt] = this.load(address, 1, true, particle) >>> 0;
        else if (op === 0x21) this.r[rt] = this.load(address, 2, true, particle) >>> 0;
        else if (op === 0x22) {
            const word = this.load(address & ~3, 4, false, particle), shift = (address & 3) * 8;
            const preserve = shift === 0 ? 0 : (0xFFFFFFFF >>> (32 - shift));
            this.r[rt] = ((word << shift) | (this.r[rt] & preserve)) >>> 0;
        }
        else if (op === 0x23) this.r[rt] = this.load(address, 4, false, particle) >>> 0;
        else if (op === 0x24) this.r[rt] = this.load(address, 1, false, particle);
        else if (op === 0x25) this.r[rt] = this.load(address, 2, false, particle);
        else if (op === 0x26) {
            const word = this.load(address & ~3, 4, false, particle), shift = (3 - (address & 3)) * 8;
            const preserve = shift === 0 ? 0 : (0xFFFFFFFF << (32 - shift));
            this.r[rt] = ((word >>> shift) | (this.r[rt] & preserve)) >>> 0;
        }
        else if (op === 0x28) this.store(address, 1, this.r[rt], particle);
        else if (op === 0x29) this.store(address, 2, this.r[rt], particle);
        else if (op === 0x2A) {
            const aligned = address & ~3, word = this.load(aligned, 4, false, particle), shift = (address & 3) * 8;
            const preserve = shift === 0 ? 0 : (0xFFFFFFFF << (32 - shift));
            this.store(aligned, 4, ((this.r[rt] >>> shift) | (word & preserve)) >>> 0, particle);
        }
        else if (op === 0x2B) this.store(address, 4, this.r[rt], particle);
        else if (op === 0x2E) {
            const aligned = address & ~3, word = this.load(aligned, 4, false, particle), shift = (3 - (address & 3)) * 8;
            const preserve = shift === 0 ? 0 : (0xFFFFFFFF >>> (32 - shift));
            this.store(aligned, 4, ((this.r[rt] << shift) | (word & preserve)) >>> 0, particle);
        }
        else if (op === 0x31) this.f[rt] = this.load(address, 4, false, particle);
        else if (op === 0x35) {
            this.f[rt] = this.load(address, 4, false, particle);
            this.f[rt + 1] = this.load(address + 4, 4, false, particle);
        }
        else if (op === 0x39) this.store(address, 4, this.f[rt], particle);
        else if (op === 0x3D) {
            this.store(address, 4, this.f[rt], particle);
            this.store(address + 4, 4, this.f[rt + 1], particle);
        }
        else if (op === 0x11) {
            const fmt = rs, fs = instruction >>> 11 & 31, fd = instruction >>> 6 & 31, fn = instruction & 63;
            const supported = fmt === 0 || fmt === 4 || fmt === 16 && [0, 1, 2, 3, 5, 6, 7, 0x32, 0x3C, 0x3E].includes(fn) || fmt === 20 && fn === 0x20;
            if (!supported) this.unimplementedInstructions.add(instruction >>> 0);
            if (fmt === 0) this.r[rt] = this.f[fs];
            else if (fmt === 4) this.f[fs] = this.r[rt];
            else if (fmt === 16) {
                const s = bitsToFloat(this.f[fs]), t = bitsToFloat(this.f[rt]);
                if (fn === 0) this.f[fd] = floatToBits(s + t);
                else if (fn === 1) this.f[fd] = floatToBits(s - t);
                else if (fn === 2) this.f[fd] = floatToBits(s * t);
                else if (fn === 3) this.f[fd] = floatToBits(s / t);
                else if (fn === 5) this.f[fd] = floatToBits(Math.abs(s));
                else if (fn === 6) this.f[fd] = this.f[fs];
                else if (fn === 7) this.f[fd] = floatToBits(-s);
                else if (fn === 0x32) this.fpCondition = s === t;
                else if (fn === 0x3C) this.fpCondition = s < t;
                else if (fn === 0x3E) this.fpCondition = s <= t;
            } else if (fmt === 20 && fn === 0x20) this.f[fd] = floatToBits(this.f[fs] | 0);
        }
        this.r[0] = 0;
    }

    public runFrame(entryOffset: number, particle: StadiumMoveEffectParticleState, moveEffectID = 0): MoveEffectParticleBehaviorCall[] {
        this.currentMoveEffectID = moveEffectID;
        particle.beginEngineFrame();
        particle.calls = [];
        // The engine composes attachment, spawn, and integrated translations
        // once per particle update before invoking the authored callback.
        particle.call(0x81408AF0, [particleAddress, 0, 0, 0, 0, 0]);
        particle.calls = [];
        this.r.fill(0); this.f.fill(0); this.hi = this.lo = 0; new Uint8Array(this.stack.buffer).fill(0);
        this.r[4] = particleAddress; this.r[29] = stackAddress + 0xF00; this.r[31] = returnSentinel;
        let pc = fragmentVirtualBase + entryOffset;
        for (let steps = 0; steps < 0x4000 && particle.alive; steps++) {
            const offset = this.fragmentOffset(pc);
            if (offset === null || offset + 4 > this.code.byteLength) break;
            const instruction = this.code.getUint32(offset), op = instruction >>> 26;
            const rs = instruction >>> 21 & 31, rt = instruction >>> 16 & 31, imm = sign16(instruction);
            let nextPC = (pc + 4) >>> 0, delayedTarget: number | null = null;
            let skipLikelyDelaySlot = false;
            if (op === 2 || op === 3) {
                // Fragment code is linked in the 0x843xxxxx window. Relocated
                // jump-table pointers use segment 0x0F, but J/JAL retain the
                // original virtual-PC high nibble at execution time.
                delayedTarget = (0x80000000 | ((instruction & 0x03FFFFFF) << 2)) >>> 0;
                if (op === 3) this.r[31] = (pc + 8) >>> 0;
            } else if (op >= 4 && op <= 7) {
                const taken = op === 4 ? this.r[rs] === this.r[rt] : op === 5 ? this.r[rs] !== this.r[rt] :
                    op === 6 ? (this.r[rs] | 0) <= 0 : (this.r[rs] | 0) > 0;
                if (taken) delayedTarget = (pc + 4 + imm * 4) >>> 0;
            } else if (op >= 0x14 && op <= 0x17) {
                const taken = op === 0x14 ? this.r[rs] === this.r[rt] : op === 0x15 ? this.r[rs] !== this.r[rt] :
                    op === 0x16 ? (this.r[rs] | 0) <= 0 : (this.r[rs] | 0) > 0;
                if (taken) delayedTarget = (pc + 4 + imm * 4) >>> 0;
                else skipLikelyDelaySlot = true;
            } else if (op === 1) {
                const taken = rt === 0 || rt === 2 ? (this.r[rs] | 0) < 0 : rt === 1 || rt === 3 ? (this.r[rs] | 0) >= 0 : false;
                if (taken) delayedTarget = (pc + 4 + imm * 4) >>> 0;
                else if (rt === 2 || rt === 3) skipLikelyDelaySlot = true;
            } else if (op === 0 && (instruction & 63) === 8) {
                delayedTarget = this.r[rs];
            } else if (op === 0x11 && rs === 8) {
                const takeOnTrue = (rt & 1) !== 0;
                if (this.fpCondition === takeOnTrue) delayedTarget = (pc + 4 + imm * 4) >>> 0;
                else if ((rt & 2) !== 0) skipLikelyDelaySlot = true;
            } else this.executeNonControl(instruction, particle);

            if (delayedTarget !== null) {
                const delayOffset = this.fragmentOffset(pc + 4);
                if (delayOffset !== null) this.executeNonControl(this.code.getUint32(delayOffset), particle);
                if (op === 3 && delayedTarget === 0x8432CED4) {
                    // func_8432CED4 queries the model engine's reverse-animation frame.
                    this.r[2] = particle.isModelAnimationAtStart() ? 1 : 0;
                    nextPC = (pc + 8) >>> 0;
                } else if (op === 3 && ((delayedTarget & 0xFFF00000) >>> 0) !== fragmentVirtualBase) {
                    const sp = this.r[29];
                    const args = [this.r[4], this.r[5], this.r[6], this.r[7],
                        this.load(sp + 0x10, 4, false, particle), this.load(sp + 0x14, 4, false, particle)];
                    this.r[2] = this.callExternal(delayedTarget, args, particle) >>> 0;
                    nextPC = (pc + 8) >>> 0;
                } else if (delayedTarget === returnSentinel) break;
                else nextPC = this.canonicalCodeAddress(delayedTarget);
            } else if (skipLikelyDelaySlot) nextPC = (pc + 8) >>> 0;
            pc = nextPC;
        }
        return particle.calls;
    }
}
