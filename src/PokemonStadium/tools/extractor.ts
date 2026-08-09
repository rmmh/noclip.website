import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { zstdCompressSync } from 'node:zlib';
import ArrayBufferSlice from '../../ArrayBufferSlice.js';
import * as BYML from '../../byml.js';
import type {
    ExtractedPokemonStadiumArchive as ModelArchive, FragmentMetadata, PokemonAnimation, PokemonAnimationTrack,
    PokemonMaterialAnimation, PokemonMaterialAnimationChannel, PokemonMetadata, StadiumMetadata,
} from '../archive.js';
import type {
    MoveEffectGeometryKind, MoveEffectMetadata, MoveEffectModelTint, MoveEffectParticleBehaviorCall,
    MoveEffectParticleSpawn, MoveEffectParticleStyle, MoveEffectPrimitive, MoveEffectRenderDescriptor,
    MoveEffectResource, MoveEffectResourceBank, MoveEffectScript,
} from '../effects.js';
import { defaultParticleModelResourceIDs, getCustomMoveEffectLifecycle } from '../effects.js';
import type { PokemonStadiumBattleTextArchive } from '../battle_text.js';
import { fragmentOffset } from './extractor_common.js';
import { collectGeoDisplayLists, parseGeoLayout, parseStadiumMetadata } from './model_graph_extractor.js';

const EXPECTED_SHA1 = 'ed7bef5a306f88c0a6e96b15e71fee2ef32058f3';

interface ArchiveSpec {
    kind: 'stadium' | 'pokemon';
    romStart: number;
    romEnd: number;
    digits: number;
}

const archiveSpecs: ArchiveSpec[] = [
    { kind: 'stadium', romStart: 0x56E7D0, romEnd: 0x5C7A70, digits: 2 },
    { kind: 'pokemon', romStart: 0x920000, romEnd: 0x15C0000, digits: 3 },
];

function hex(value: number, digits: number): string {
    return value.toString(16).toUpperCase().padStart(digits, '0');
}

function decompressYay0(src: Buffer): Buffer {
    if (src.toString('ascii', 0, 4) !== 'Yay0')
        throw new Error('missing Yay0 stream');
    const output = Buffer.alloc(src.readUInt32BE(4));
    let maskOffset = 0x10, linkOffset = src.readUInt32BE(8), chunkOffset = src.readUInt32BE(0x0C);
    let mask = 0, bitsLeft = 0, dst = 0;
    while (dst < output.length) {
        if (bitsLeft === 0) {
            mask = src.readUInt32BE(maskOffset); maskOffset += 4; bitsLeft = 32;
        }
        if ((mask & 0x80000000) !== 0) {
            output[dst++] = src[chunkOffset++];
        } else {
            const link = src.readUInt16BE(linkOffset); linkOffset += 2;
            let count = link >>> 12;
            if (count === 0) count = src[chunkOffset++] + 18;
            else count += 2;
            let copy = dst - (link & 0x0FFF) - 1;
            if (copy < 0) throw new Error('invalid Yay0 back-reference');
            while (count-- > 0 && dst < output.length) output[dst++] = output[copy++];
        }
        mask <<= 1; bitsLeft--;
    }
    return output;
}

function extractEntry(blob: Buffer, offset: number, size: number): { data: Buffer; compression: string; relocations: { Offset: number; Value: number }[] } {
    const entry = blob.subarray(offset, offset + size);
    // Pokémon entry 120 is an uncompressed overlay ("FRAGMENT"), not a model.
    // Keep it in the archive so IDs remain identical to the game's file table.
    if (entry.toString('ascii', 0, 8) !== 'PERS-SZP')
        return { data: Buffer.from(entry), compression: 'raw', relocations: [] };
    const headerSize = entry.readUInt32BE(8);
    const initializedSize = entry.readUInt32BE(0x0C);
    const allocationSize = entry.readUInt32BE(0x10);
    const relocationCount = entry.readUInt32BE(0x14);
    if (headerSize !== 0x18 + relocationCount * 8 || headerSize >= entry.length)
        throw new Error(`invalid PERS-SZP header at 0x${offset.toString(16)}`);
    const initialized = decompressYay0(entry.subarray(headerSize));
    if (initialized.length !== initializedSize || initializedSize > allocationSize)
        throw new Error(`invalid decompressed size at 0x${offset.toString(16)}`);
    const data = Buffer.alloc(allocationSize);
    initialized.copy(data);
    const relocations = [];
    for (let i = 0; i < relocationCount; i++) {
        const value = entry.readUInt32BE(0x18 + i * 8);
        const relocationOffset = entry.readUInt32BE(0x1C + i * 8);
        if (relocationOffset + 4 > data.length) throw new Error('relocation outside allocation');
        data.writeUInt32BE(value, relocationOffset);
        relocations.push({ Offset: relocationOffset, Value: value });
    }
    return { data, compression: 'PERS-SZP', relocations };
}

function parseFragment(data: Buffer): FragmentMetadata | undefined {
    if (data.toString('ascii', 8, 16) !== 'FRAGMENT') return undefined;
    return { RelocOffset: data.readUInt32BE(0x14), SizeInROM: data.readUInt32BE(0x18), SizeInRAM: data.readUInt32BE(0x1C) };
}

function normalizeFragmentPointers(data: Buffer, fragment: FragmentMetadata): void {
    const relocationCount = data.readUInt32BE(fragment.RelocOffset);
    for (let i = 0; i < relocationCount; i++) {
        const relocation = data.readUInt32BE(fragment.RelocOffset + 4 + i * 4);
        if ((relocation >>> 24) !== 2) continue; // R_MIPS_32
        const offset = relocation & 0x00FFFFFF;
        if (offset + 4 > data.length) throw new Error('fragment relocation outside payload');
        const address = data.readUInt32BE(offset);
        const linkedBase = ((address & 0xFFF00000) >>> 0);
        if (linkedBase === 0x8FF00000 || linkedBase === 0x84300000)
            data.writeUInt32BE(0x0F000000 | (address & 0x000FFFFF), offset);
    }
}

function parseMoveEffectResources(archiveID: number, data: Buffer): MoveEffectResource[] {
    // process_model_resource_list consumes this zero-terminated list. Type 3 entries are geo
    // layouts; all entries are installed into gMoveEffectResources by their resource ID.
    const resources: MoveEffectResource[] = [];
    const fragment = parseFragment(data);
    const listOffset = fragment !== undefined ? 0x20 : 0;
    for (let entry = listOffset; entry + 8 <= data.length; entry += 8) {
        const type = data.readInt8(entry);
        if (type === 0) return resources;
        const pointer = data.readUInt32BE(entry + 4);
        const dataOffset = pointer & 0x000FFFFF;
        if (dataOffset >= data.length) throw new Error(`move effect resource pointer 0x${pointer.toString(16)} outside resource bank`);
        const resource = { ArchiveID: archiveID, ResourceID: data.readInt16BE(entry + 2), DataOffset: dataOffset };
        if (type === 1 || type === 2) resources.push({ ...resource, Type: type });
        else if (type === 3) resources.push({ ...resource, Type: 3, GeoNodes: parseGeoLayout(data, dataOffset) });
        else if (type === 4) resources.push({ ...resource, Type: 4, Animation: parseAnimationAt(data, dataOffset) });
        else throw new Error(`unsupported move effect resource type ${type}`);
    }
    throw new Error('unterminated move effect resource list');
}

function parseMoveEffectMetadata(data: Buffer, resourceBanks: Buffer[]): MoveEffectMetadata {
    // fragment62_315D50.c: gMoveEffectScripts[166][5]. The first three lists are
    // zero-terminated effect primitive IDs; attachment lists end in 0x3F.
    const tableOffset = 0x86E08;
    const moveCount = 166;
    const readScript = (pointerOffset: number, terminator: number): number[] => {
        const address = data.readUInt32BE(pointerOffset);
        if ((address >>> 24) !== 0x0F) throw new Error(`move effect script has unnormalized pointer 0x${address.toString(16)}`);
        let cursor = address & 0x00FFFFFF;
        const values: number[] = [];
        while (cursor < data.length && data[cursor] !== terminator) values.push(data[cursor++]);
        if (cursor >= data.length) throw new Error('unterminated move effect script');
        return values;
    };
    const scripts: MoveEffectScript[] = [];
    for (let move = 0; move < moveCount; move++) {
        const entry = tableOffset + move * 0x14;
        scripts.push({
            AttackerSetup: readScript(entry + 0x00, 0),
            AttackerAction: readScript(entry + 0x04, 0),
            TargetAction: readScript(entry + 0x08, 0),
            AttackerAttachments: readScript(entry + 0x0C, 0x3F),
            TargetAttachments: readScript(entry + 0x10, 0x3F),
        });
    }

    // Swords Dance's authored +2 Attack result is dispatched separately from
    // the move script through D_84386D44[1]: primitive 0x85 with bank 0x2C.
    // Keep it associated with the move in the standalone viewer so the move
    // field and its result animation play as one sequence, as in battle.
    const moveResultPrimitives = Array.from({ length: moveCount }, () => [] as number[]);
    const moveResultResourceBanks = Array.from({ length: moveCount }, () => [] as number[]);
    moveResultPrimitives[14] = [0x85];
    moveResultResourceBanks[14] = [0x2C];

    // dispatch_move_effect_primitives dispatches a primitive through these four tables, then
    // registers its update/render pair in the engine's eight effect slots.
    // Preserve the original entry points so each implementation can be traced
    // back to its authoritative decomp routine without relying on table order.
    const readFunction = (tableOffset: number, index: number): number => {
        const address = data.readUInt32BE(tableOffset + index * 4);
        if ((address >>> 24) !== 0x0F) throw new Error(`move effect function has unnormalized pointer 0x${address.toString(16)}`);
        return address & 0x00FFFFFF;
    };
    const tracePrimitiveSetup = (entryOffset: number): { styles: number[]; spawns: MoveEffectParticleSpawn[]; modelTints: MoveEffectModelTint[] } => {
        const styles = new Set<number>();
        const spawns: MoveEffectParticleSpawn[] = [];
        const modelTints: MoveEffectModelTint[] = [];
        const visited = new Set<number>();
        let schedulerDelay = 0;
        const addSpawn = (delay: number | undefined, interval: number | undefined, mode: number | undefined,
            callback: number | undefined, style: number, burstCount: number | undefined,
            spawnArguments: (number | undefined)[]): void => {
            if (style >= 0) styles.add(style);
            const arguments_ = spawnArguments.map((value) => value ?? -1);
            spawns.push({
                Delay: delay === undefined ? -1 : delay + schedulerDelay,
                Interval: interval ?? -1,
                Mode: mode ?? -1,
                BurstCount: burstCount ?? -1,
                UpdateFunction: callback !== undefined && ((callback & 0xFFF00000) >>> 0) === 0x84300000 ? callback - 0x84300000 : -1,
                ParticleStyle: style,
                ModelResources: [],
                ModelAnimationFrameCount: 0,
                Arguments: arguments_,
                InitialState: {
                    A6: arguments_[0] ?? -1, AA: arguments_[1] ?? -1, CC: arguments_[2] ?? -1,
                    CD: arguments_[3] ?? -1, CF: arguments_[4] ?? -1, CE: arguments_[5] ?? -1,
                },
                PaletteIndices: [],
                PrimitiveColorIndices: [],
                EnvironmentColorIndices: [],
                BehaviorCalls: [],
            });
        };
        const addModelTint = (delay: number | undefined, updateFunction: number, args: (number | undefined)[]): void => {
            modelTints.push({
                Delay: delay === undefined ? -1 : delay + schedulerDelay,
                UpdateFunction: updateFunction,
                Arguments: args.map((value) => value ?? -1),
            });
        };
        const trace = (functionOffset: number, depth: number, arguments_: (number | undefined)[] = []): void => {
            if (depth > 6 || visited.has(functionOffset) || functionOffset < 0x2E000 || functionOffset >= 0x5D000) return;
            visited.add(functionOffset);
            const registers: (number | undefined)[] = new Array(32);
            registers[0] = 0;
            registers[29] = 0;
            for (let i = 0; i < 4; i++) registers[4 + i] = arguments_[i];
            const stack = new Map<number, number | undefined>();
            for (let pc = functionOffset, instructions = 0; pc + 4 <= data.length && instructions < 0x1000; pc += 4, instructions++) {
                const instruction = data.readUInt32BE(pc);
                const opcode = instruction >>> 26;
                const rs = instruction >>> 21 & 0x1F;
                const rt = instruction >>> 16 & 0x1F;
                if (opcode === 0x0F) {
                    registers[rt] = (instruction & 0xFFFF) << 16;
                } else if (opcode === 0x09 && registers[rs] !== undefined) {
                    registers[rt] = (registers[rs]! + (instruction << 16 >> 16)) >>> 0;
                } else if (opcode === 0x0D && registers[rs] !== undefined) {
                    registers[rt] = (registers[rs]! | (instruction & 0xFFFF)) >>> 0;
                } else if (opcode === 0 && ((instruction & 0x3F) === 0x21 || (instruction & 0x3F) === 0x25)) {
                    const rd = instruction >>> 11 & 0x1F;
                    const lhs = registers[rs], rhs = registers[rt];
                    registers[rd] = lhs !== undefined && rhs !== undefined ?
                        ((instruction & 0x3F) === 0x25 ? lhs | rhs : lhs + rhs) >>> 0 : undefined;
                } else if (opcode === 0x2B && registers[rs] !== undefined) {
                    stack.set((registers[rs]! + (instruction << 16 >> 16)) | 0, registers[rt]);
                } else if (opcode === 0x03) {
                    // MIPS executes the instruction after JAL before entering
                    // the callee. Stadium commonly fills the final argument in
                    // that delay slot, so it must be applied before capturing
                    // registers/stack arguments.
                    const delay = data.readUInt32BE(pc + 4);
                    const delayOpcode = delay >>> 26, delayRs = delay >>> 21 & 0x1F, delayRt = delay >>> 16 & 0x1F;
                    if (delayOpcode === 0x0F) registers[delayRt] = (delay & 0xFFFF) << 16;
                    else if (delayOpcode === 0x09 && registers[delayRs] !== undefined) registers[delayRt] = (registers[delayRs]! + (delay << 16 >> 16)) >>> 0;
                    else if (delayOpcode === 0x0D && registers[delayRs] !== undefined) registers[delayRt] = (registers[delayRs]! | (delay & 0xFFFF)) >>> 0;
                    else if (delayOpcode === 0x2B && registers[delayRs] !== undefined) stack.set((registers[delayRs]! + (delay << 16 >> 16)) | 0, registers[delayRt]);
                    else if (delayOpcode === 0 && ((delay & 0x3F) === 0x21 || (delay & 0x3F) === 0x25)) {
                        const delayRd = delay >>> 11 & 0x1F;
                        const lhs = registers[delayRs], rhs = registers[delayRt];
                        registers[delayRd] = lhs !== undefined && rhs !== undefined ? (lhs + rhs) >>> 0 : undefined;
                    } else if (delayRt !== 0 && delayOpcode !== 0x2B && delayOpcode !== 0x29 && delayOpcode !== 0x28)
                        registers[delayRt] = undefined;
                    const target = (((0x84300000 + pc + 4) & 0xF0000000) | ((instruction & 0x03FFFFFF) << 2)) >>> 0;
                    const targetOffset = target - 0x84300000;
                    const stackPointer = (registers[29] ?? 0) | 0;
                    const stackArgument = (index: number): number | undefined => stack.get(stackPointer + 0x10 + index * 4);
                    const callArguments = [registers[4], registers[5], registers[6], registers[7],
                        stackArgument(0), stackArgument(1), stackArgument(2), stackArgument(3),
                        stackArgument(4), stackArgument(5), stackArgument(6), stackArgument(7)];
                    if (targetOffset === 0x2EB64 || targetOffset === 0x2EC28 || targetOffset === 0x2ECA0) {
                        const extendedArguments = [stackArgument(0), stackArgument(1), stackArgument(2), stackArgument(3),
                            stackArgument(4), stackArgument(5), stackArgument(6), stackArgument(7)];
                        const styleAddress = targetOffset === 0x2EC28 ? registers[6] : extendedArguments[0];
                        const style = styleAddress === 0x8140E460 ? -1 :
                            styleAddress !== undefined && styleAddress >= 0x843861D0 && styleAddress < 0x843861D0 + 85 * 8
                                ? (styleAddress - 0x843861D0) / 8 : -2;
                        const callback = targetOffset === 0x2EC28 ? registers[5] : registers[7];
                        const spawnArguments = targetOffset === 0x2EB64 ? extendedArguments.slice(2, 8) : targetOffset === 0x2EC28
                            ? [registers[7], ...extendedArguments]
                            : [extendedArguments[1], extendedArguments[2], extendedArguments[3], extendedArguments[4], extendedArguments[5], extendedArguments[6]];
                        if (Number.isInteger(style) && style >= -1) {
                            addSpawn(registers[4], targetOffset === 0x2EC28 ? 0 : registers[5],
                                targetOffset === 0x2EC28 ? 1 : registers[6], callback, style,
                                targetOffset === 0x2EB64 ? extendedArguments[3] :
                                    targetOffset === 0x2ECA0 ? extendedArguments[2] : extendedArguments[0], spawnArguments);
                        }
                    } else if ([0x2ED74, 0x2EDE8, 0x2EE5C, 0x2EED0, 0x2EF40, 0x2EFB4,
                        0x2F028, 0x2F098, 0x2F104, 0x2F174, 0x2F1E0, 0x2F254].includes(targetOffset)) {
                        // fragment62_317E70.c: convenience wrappers for the
                        // full-screen style-37 particle. Decode their public
                        // signatures here, where all incoming arguments are
                        // still available, instead of guessing stack loads in
                        // each compiled wrapper body.
                        let callback = -1, interval = 0, mode = 1;
                        let args: (number | undefined)[] | null = null;
                        switch (targetOffset) {
                        case 0x2ED74: callback = 0x32CD0; args = [callArguments[1], callArguments[2], 0x16, callArguments[4], callArguments[3], 0]; break;
                        case 0x2EDE8: callback = 0x32DB0; args = [callArguments[1], callArguments[2], 0x16, 0xFF, callArguments[3], 0]; break;
                        case 0x2EE5C: callback = 0x32DB0; args = [callArguments[1], callArguments[2], 0x16, callArguments[4], callArguments[3], 0]; break;
                        case 0x2EED0: callback = 0x32DB0; interval = callArguments[1] ?? -1; mode = callArguments[2] ?? -1; args = [callArguments[3], callArguments[4], 0x16, callArguments[6], callArguments[5], 0]; break;
                        case 0x2EF40: callback = 0x32E6C; args = [callArguments[1], callArguments[2], 0x16, 0xFF, callArguments[3], 0]; break;
                        case 0x2EFB4: callback = 0x32E6C; args = [callArguments[1], callArguments[2], 0x16, callArguments[4], callArguments[3], 0]; break;
                        case 0x2F028: callback = 0x32E6C; interval = callArguments[1] ?? -1; mode = callArguments[2] ?? -1; args = [callArguments[3], callArguments[4], 0x16, callArguments[6], callArguments[5], 0]; break;
                        case 0x2F098: callback = 0x32F30; args = [callArguments[1], 0, 0x16, 0xFF, callArguments[2], 0]; break;
                        case 0x2F104: callback = 0x32F30; args = [callArguments[1], 0, 0x16, callArguments[3], callArguments[2], 0]; break;
                        case 0x2F174: callback = 0x32F30; interval = callArguments[1] ?? -1; mode = callArguments[2] ?? -1; args = [callArguments[3], 0, 0x16, callArguments[5], callArguments[4], 0]; break;
                        case 0x2F1E0: callback = 0x32FD0; args = [callArguments[1], callArguments[2], 0x16, callArguments[4], callArguments[3], 0]; break;
                        case 0x2F254: callback = 0x330A0; args = [callArguments[1], callArguments[2], 0x16, callArguments[4], callArguments[3], 0]; break;
                        }
                        if (args !== null) addSpawn(callArguments[0], interval, mode, 0x84300000 + callback, 37, 1, args);
                    } else if ([0x2F2C8, 0x2F344, 0x2F3C4, 0x2F440, 0x2F4BC, 0x2F538,
                        0x2F5B8, 0x2F638, 0x2F6B8, 0x2F728, 0x2F7A0, 0x2F818, 0x2F884].includes(targetOffset)) {
                        // fragment62_317E70.c: these wrappers schedule a
                        // model-local fog/tint callback through gDefaultParticleStyle.
                        let callback = -1;
                        let args: (number | undefined)[] = [];
                        switch (targetOffset) {
                        case 0x2F2C8: callback = 0x31EAC; args = [callArguments[2], callArguments[4], 0x1A, callArguments[3], callArguments[1], 0]; break;
                        case 0x2F344: callback = 0x31FAC; args = [callArguments[1], callArguments[5], 0x1A, callArguments[4], callArguments[2], callArguments[3]]; break;
                        case 0x2F3C4: callback = 0x320A4; args = [callArguments[1], callArguments[4], 0x1A, 0, callArguments[2], callArguments[3]]; break;
                        case 0x2F440:
                        case 0x2F4BC: callback = 0x321BC; args = [callArguments[4], callArguments[3], 0x1A, callArguments[2], callArguments[1], 0]; break;
                        case 0x2F538:
                        case 0x2F5B8: callback = 0x323BC; args = [callArguments[4], callArguments[3], 0x1A, callArguments[2], callArguments[1], callArguments[5]]; break;
                        case 0x2F638: callback = 0x32604; args = [callArguments[4], callArguments[3], 0x1A, callArguments[2], callArguments[1], callArguments[5]]; break;
                        case 0x2F6B8: callback = 0x327B8; args = [0, callArguments[1], 0x1A, callArguments[2], 0, 0]; break;
                        case 0x2F728: callback = 0x32964; args = [callArguments[1], callArguments[2], 0x1A, callArguments[3], 0, 0]; break;
                        case 0x2F7A0: callback = 0x32AFC; args = [callArguments[1], callArguments[3], 0x1A, callArguments[2], 0, 0]; break;
                        case 0x2F818: callback = 0x32AFC; args = [0xFF, 0xFF, 0x1A, 0xFF, 0, 0]; break;
                        case 0x2F884: callback = 0x32AFC; args = [0, 0xFF, 0x1A, 0, 0, 0]; break;
                        }
                        addModelTint(callArguments[0], callback, args);
                    } else if (targetOffset === 0x2EB14 || targetOffset === 0x2EB44) {
                        schedulerDelay = 0;
                    } else if (targetOffset === 0x2EB20 && callArguments[0] !== undefined) {
                        schedulerDelay = callArguments[0];
                    } else if (targetOffset === 0x2EB2C && callArguments[0] !== undefined) {
                        schedulerDelay += callArguments[0];
                    } else if (((target & 0xFFF00000) >>> 0) === 0x84300000) {
                        trace(targetOffset, depth + 1, [registers[4], registers[5], registers[6], registers[7], stackArgument(0), stackArgument(1), stackArgument(2)]);
                    }
                    registers[2] = undefined;
                    registers[3] = undefined;
                    pc += 4; instructions++;
                } else if (opcode === 0 && (instruction & 0x3F) === 8 && rs === 31) {
                    break;
                } else if (rt !== 0 && opcode !== 0x04 && opcode !== 0x05 && opcode !== 0x06 && opcode !== 0x07) {
                    // Preserve known values through stores and branches, but
                    // invalidate destinations of arithmetic we do not model.
                    if (opcode !== 0x2B && opcode !== 0x29 && opcode !== 0x28) registers[rt] = undefined;
                }
                for (const value of registers) {
                    if (value !== undefined && value >= 0x843861D0 && value < 0x843861D0 + 85 * 8 && ((value - 0x843861D0) & 7) === 0)
                        styles.add((value - 0x843861D0) / 8);
                }
            }
        };
        trace(entryOffset, 0);
        // Runtime conditionals can place an alternate spawn block after the
        // common tail in machine-code order. The lightweight tracer sees both
        // paths, but registers at that later branch target are not necessarily
        // available. Reconcile unresolved callback registers with the unique
        // callback authored for the same particle style (or identical initial
        // particle state) on the sibling path. Reject switch jump interiors as
        // callback entries; they consume a selector prepared by their function
        // prologue and are never valid scheduler callbacks themselves.
        const isComputedJumpInterior = (offset: number): boolean => {
            if (offset < 0 || offset + 16 > data.length) return false;
            const a = data.readUInt32BE(offset), b = data.readUInt32BE(offset + 4);
            const c = data.readUInt32BE(offset + 8), d = data.readUInt32BE(offset + 12);
            return a >>> 26 === 0x0F && b >>> 26 === 0 && (b & 0x3F) === 0x21 &&
                c >>> 26 === 0x23 && d >>> 26 === 0 && (d & 0x3F) === 8;
        };
        for (const spawn of spawns) {
            if (spawn.UpdateFunction >= 0 && !isComputedJumpInterior(spawn.UpdateFunction)) continue;
            const styleCallbacks = new Set(spawns.filter((candidate) => candidate.ParticleStyle === spawn.ParticleStyle &&
                candidate.UpdateFunction >= 0 && !isComputedJumpInterior(candidate.UpdateFunction)).map((candidate) => candidate.UpdateFunction));
            if (styleCallbacks.size === 1) spawn.UpdateFunction = [...styleCallbacks][0];
            else {
                const sibling = spawns.find((candidate) => candidate !== spawn && candidate.UpdateFunction >= 0 &&
                    !isComputedJumpInterior(candidate.UpdateFunction) && candidate.Arguments.slice(0, 6).every((value, i) => value === spawn.Arguments[i]));
                if (sibling !== undefined) {
                    spawn.UpdateFunction = sibling.UpdateFunction;
                    spawn.Delay = Math.min(spawn.Delay, sibling.Delay);
                }
            }
        }
        return { styles: [...styles].sort((a, b) => a - b), spawns, modelTints };
    };
    const traceParticleColors = (entryOffset: number, particleArguments: number[]): {
        palettes: number[]; primitive: number[]; environment: number[]; calls: MoveEffectParticleBehaviorCall[];
        models: { ModelResourceID: number; AnimationResourceID: number; Reverse: boolean }[];
    } => {
        const palettes = new Set<number>();
        const primitive = new Set<number>();
        const environment = new Set<number>();
        const calls: MoveEffectParticleBehaviorCall[] = [];
        const models: { ModelResourceID: number; AnimationResourceID: number; Reverse: boolean }[] = [];
        const addModel = (model: number, animation: number, reverse = false): void => {
            if (!Number.isInteger(model) || model < 0 || model >= 256 || !Number.isInteger(animation) || animation >= 256) return;
            if (!models.some((pair) => pair.ModelResourceID === model && pair.AnimationResourceID === animation && pair.Reverse === reverse))
                models.push({ ModelResourceID: model, AnimationResourceID: animation, Reverse: reverse });
        };
        const rampA = [12, 25, 35, 54, 47, 59]; // gMoveEffectColorRampA
        const rampB = [23, 25, 37, 35, 53, 20]; // gMoveEffectColorRampB
        const visited = new Set<number>();
        const trace = (functionOffset: number, arguments_: (number | undefined)[] = [], depth = 0): void => {
            if (depth > 5 || visited.has(functionOffset) || functionOffset < 0x2E000 || functionOffset >= 0x5D000) return;
            visited.add(functionOffset);
            const registers: (number | undefined)[] = new Array(32);
            registers[0] = 0;
            registers[29] = 0;
            for (let i = 0; i < 4; i++) registers[4 + i] = arguments_[i];
            const stack = new Map<number, number | undefined>();
            for (let pc = functionOffset, instructions = 0; pc + 4 <= data.length && instructions < 0x800; pc += 4, instructions++) {
                const instruction = data.readUInt32BE(pc);
                const opcode = instruction >>> 26;
                const rs = instruction >>> 21 & 0x1F;
                const rt = instruction >>> 16 & 0x1F;
                if (opcode === 0x0F) registers[rt] = (instruction & 0xFFFF) << 16;
                else if (opcode === 0x09 && registers[rs] !== undefined) registers[rt] = (registers[rs]! + (instruction << 16 >> 16)) >>> 0;
                else if (opcode === 0x0D && registers[rs] !== undefined) registers[rt] = (registers[rs]! | (instruction & 0xFFFF)) >>> 0;
                else if (opcode === 0 && ((instruction & 0x3F) === 0x21 || (instruction & 0x3F) === 0x25)) {
                    const rd = instruction >>> 11 & 0x1F;
                    const lhs = registers[rs], rhs = registers[rt];
                    registers[rd] = lhs !== undefined && rhs !== undefined ? (lhs + rhs) >>> 0 : undefined;
                }
                else if (opcode === 0x2B && registers[rs] !== undefined)
                    stack.set((registers[rs]! + (instruction << 16 >> 16)) | 0, registers[rt]);
                else if (opcode === 0x03) {
                    const delay = data.readUInt32BE(pc + 4);
                    const delayOpcode = delay >>> 26, delayRs = delay >>> 21 & 0x1F, delayRt = delay >>> 16 & 0x1F;
                    if (delayOpcode === 0x0F) registers[delayRt] = (delay & 0xFFFF) << 16;
                    else if (delayOpcode === 0x09 && registers[delayRs] !== undefined) registers[delayRt] = (registers[delayRs]! + (delay << 16 >> 16)) >>> 0;
                    else if (delayOpcode === 0x0D && registers[delayRs] !== undefined) registers[delayRt] = (registers[delayRs]! | (delay & 0xFFFF)) >>> 0;
                    else if (delayOpcode === 0 && ((delay & 0x3F) === 0x21 || (delay & 0x3F) === 0x25)) {
                        const delayRd = delay >>> 11 & 0x1F;
                        const lhs = registers[delayRs], rhs = registers[delayRt];
                        registers[delayRd] = lhs !== undefined && rhs !== undefined ? (lhs + rhs) >>> 0 : undefined;
                    } else if (delayOpcode === 0x2B && registers[delayRs] !== undefined)
                        stack.set((registers[delayRs]! + (delay << 16 >> 16)) | 0, registers[delayRt]);
                    else if (delayRt !== 0 && delayOpcode !== 0x2B && delayOpcode !== 0x29 && delayOpcode !== 0x28)
                        registers[delayRt] = undefined;
                    const target = (((0x84300000 + pc + 4) & 0xF0000000) | ((instruction & 0x03FFFFFF) << 2)) >>> 0;
                    if (((target & 0xFFF00000) >>> 0) === 0x81400000) {
                        const sp = (registers[29] ?? 0) | 0;
                        calls.push({
                            Function: target,
                            Arguments: [registers[4], registers[5], registers[6], registers[7],
                                stack.get(sp + 0x10), stack.get(sp + 0x14)].map((value) => value ?? -1),
                        });
                    }
                    if (target === 0x8140D5A0 && registers[5] !== undefined && registers[5]! >= 0 && registers[5]! < 81)
                        palettes.add(registers[5]!);
                    else if (target === 0x8140D530 && registers[5] !== undefined && registers[5]! >= 0 && registers[5]! < 66)
                        primitive.add(registers[5]!);
                    else if (target === 0x8140D568 && registers[5] !== undefined && registers[5]! >= 0 && registers[5]! < 66)
                        environment.add(registers[5]!);
                    else if ((target === 0x8140D5F0 || target === 0x8140D624) && registers[5] !== undefined && registers[5]! >= 0 && registers[5]! < rampA.length)
                        (target === 0x8140D5F0 ? primitive : environment).add(rampA[registers[5]!]!);
                    else if ((target === 0x8140D658 || target === 0x8140D68C) && registers[5] !== undefined && registers[5]! >= 0 && registers[5]! < rampB.length)
                        (target === 0x8140D658 ? primitive : environment).add(rampB[registers[5]!]!);
                    else if (target === 0x8432CD70 && registers[5] !== undefined && registers[6] !== undefined)
                        addModel(registers[5], registers[6]);
                    else if (target === 0x8432CE00 && registers[5] !== undefined)
                        addModel(registers[5], -1);
                    else if ((target === 0x8432CE3C || target === 0x8432CE78) && registers[5] !== undefined) {
                        const unresolved = models.filter((pair) => pair.AnimationResourceID < 0);
                        for (const pair of unresolved) {
                            pair.AnimationResourceID = registers[5];
                            pair.Reverse = target === 0x8432CE78;
                        }
                    } else if (target === 0x84340E40) {
                        const pair = defaultParticleModelResourceIDs(particleArguments[4]);
                        const mode = registers[5];
                        if (pair !== null) addModel(pair[0], mode === 2 ? -1 : pair[1], mode === 1);
                    } else if (((target & 0xFFF00000) >>> 0) === 0x84300000)
                        trace(target - 0x84300000, [registers[4], registers[5], registers[6], registers[7]], depth + 1);
                    // get_particle_palette_index returns particle->unk_CF. The scheduler
                    // copies ECA0 arg9 / EC28 arg7 into that field.
                    registers[2] = target === 0x8140C058 ? particleArguments[4] : undefined;
                    registers[3] = undefined;
                    pc += 4; instructions++;
                } else if (opcode === 0 && (instruction & 0x3F) === 8 && rs === 31) break;
                else if (rt !== 0 && opcode !== 0x04 && opcode !== 0x05 && opcode !== 0x06 && opcode !== 0x07 && opcode !== 0x2B && opcode !== 0x29 && opcode !== 0x28)
                    registers[rt] = undefined;
            }
        };
        trace(entryOffset);
        return { palettes: [...palettes], primitive: [...primitive], environment: [...environment], calls, models };
    };
    const readPrimitives = (count: number, setupTable: number, spawnTable: number, updateTable: number, renderTable: number): MoveEffectPrimitive[] => {
        const primitives: MoveEffectPrimitive[] = [];
        for (let i = 0; i < count; i++) {
            const setupFunction = readFunction(setupTable, i);
            const setup = tracePrimitiveSetup(setupFunction);
            for (const spawn of setup.spawns) {
                if (spawn.UpdateFunction >= 0) {
                    const colors = traceParticleColors(spawn.UpdateFunction, spawn.Arguments);
                    spawn.PaletteIndices = colors.palettes;
                    spawn.PrimitiveColorIndices = colors.primitive;
                    spawn.EnvironmentColorIndices = colors.environment;
                    spawn.BehaviorCalls = colors.calls;
                    spawn.ModelResources = colors.models;
                    if (spawn.UpdateFunction === 0x4B21C) {
                        const selector = spawn.InitialState.CD;
                        const model = selector === 0 || selector === 1 ? 0x8C : selector === 2 || selector === 3 ? 0x8E : 0x8D;
                        spawn.ModelResources = [{ ModelResourceID: model, AnimationResourceID: -1, Reverse: false }];
                    }
                }
            }
            const spawnFunction = readFunction(spawnTable, i);
            primitives.push({
                SetupFunction: setupFunction,
                SpawnFunction: spawnFunction,
                UpdateFunction: readFunction(updateTable, i),
                RenderFunction: readFunction(renderTable, i),
                ParticleStyles: setup.styles,
                ParticleSpawns: setup.spawns,
                ModelTints: setup.modelTints,
                CustomLifecycle: getCustomMoveEffectLifecycle(spawnFunction),
            });
        }
        return primitives;
    };
    // The setup tables span gAttackerMoveEffectSetupFunctions..gTargetMoveEffectSetupFunctions and
    // the beginning and end of the target setup table respectively.
    const attackerPrimitiveCount = 145;
    const targetPrimitiveCount = 90;

    // gMoveEffectParticleStyleEntries selects one of fragment34's texture upload and particle draw
    // paths. These routines fully determine the raw texel format and frame
    // dimensions used by the resource pointer in gMoveEffectResources.
    const textureLayouts = new Map<number, [number, number, number, number]>([
        [0x140C760, [0, 2, 32, 32]], [0x140C78C, [3, 1, 32, 32]], [0x140C7C0, [3, 1, 32, 32]],
        [0x140C7EC, [3, 1, 32, 64]], [0x140C820, [4, 0, 32, 32]], [0x140C84C, [4, 0, 32, 32]],
        [0x140C880, [4, 0, 32, 32]], [0x140C8B8, [4, 0, 32, 32]], [0x140C8F4, [4, 0, 32, 32]],
        [0x140C930, [4, 0, 32, 32]], [0x140C96C, [4, 0, 24, 24]], [0x140C9B0, [4, 0, 24, 24]],
        [0x140C9EC, [4, 0, 32, 64]], [0x140CA30, [4, 0, 32, 64]], [0x140CA64, [4, 0, 64, 64]],
        [0x140CA90, [4, 0, 64, 64]], [0x140CAC8, [4, 0, 64, 64]], [0x140CB04, [4, 0, 64, 64]],
        [0x140CB38, [4, 0, 64, 64]], [0x140CB64, [3, 1, 64, 64]],
    ]);
    // Texture loaders either use a fixed pointer, a fragment34 global clock,
    // or the particle's unk_C7 animation frame.
    const animatedTextureLoaders = new Map<number, ['global' | 'particle', number]>([
        [0x140C78C, ['particle', 8]], [0x140C7EC, ['particle', 8]], [0x140C84C, ['particle', 8]],
        [0x140C880, ['global', 8]], [0x140C8B8, ['global', 4]], [0x140C8F4, ['global', 4]],
        [0x140C930, ['global', 8]], [0x140C96C, ['global', 8]], [0x140C9B0, ['particle', 8]],
        [0x140C9EC, ['global', 10]], [0x140CA30, ['particle', 8]], [0x140CA90, ['global', 8]],
        [0x140CAC8, ['global', 8]], [0x140CB04, ['particle', 8]],
    ]);
    const renderDescriptorCount = (0x861D0 - 0x85E40) / 0x10;
    const renderGeometry = new Map<number, [MoveEffectGeometryKind, boolean]>([
        [0x140CB90, ['center32', true]], [0x140CC04, ['center24', true]], [0x140CC90, ['center24', false]],
        [0x140CD80, ['center32', true]], [0x140CDDC, ['center32', true]], [0x140CE68, ['color32', true]],
        [0x140CED4, ['bottom32', true]], [0x140CF30, ['center32', true]], [0x140CFBC, ['center32', true]],
        [0x140D050, ['triangle32', true]], [0x140D0E4, ['tall64', true]], [0x140D170, ['center32', true]],
        [0x140D1FC, ['bottom64', true]], [0x140D288, ['center64', true]], [0x140D314, ['center64', false]],
        [0x140D404, ['ground128', false]],
    ]);
    const renderDescriptors: MoveEffectRenderDescriptor[] = [];
    for (let index = 0; index < renderDescriptorCount; index++) {
        const entry = 0x85E40 + index * 0x10;
        const textureLoadFunction = data.readUInt32BE(entry + 4) & 0x01FFFFFF;
        const layout = textureLayouts.get(textureLoadFunction);
        if (layout === undefined) throw new Error(`unknown move effect texture loader 0x${textureLoadFunction.toString(16)}`);
        const resourcePointer = data.readUInt32BE(entry + 0x0C) & 0x000FFFFF;
        const resourceID = (resourcePointer - 0x920C0) / 4;
        if (!Number.isInteger(resourceID) || resourceID < 0 || resourceID >= 256)
            throw new Error(`invalid move effect descriptor resource pointer 0x${resourcePointer.toString(16)}`);
        const animation = animatedTextureLoaders.get(textureLoadFunction);
        const renderFunction = data.readUInt32BE(entry + 8) & 0x01FFFFFF;
        const geometry = renderGeometry.get(renderFunction) ?? ['center32', true] as const;
        renderDescriptors.push({
            Flags: data.readUInt32BE(entry) >>> 16,
            TextureLoadFunction: textureLoadFunction,
            RenderFunction: renderFunction,
            ResourceID: resourceID,
            TextureFormat: layout[0], TextureSize: layout[1], Width: layout[2], Height: layout[3],
            TextureFrameCount: animation?.[1] ?? 1,
            TextureFrameMode: animation?.[0] ?? 'static',
            GeometryKind: geometry[0], Billboard: geometry[1],
            GeometryResourceID: -1,
            SecondaryResourceID: -1, SecondaryTextureFormat: 0, SecondaryTextureSize: 0,
            SecondaryWidth: 0, SecondaryHeight: 0, DualTextureMode: 'none',
        });
    }
    const particleStyles: MoveEffectParticleStyle[] = [];
    for (let index = 0; index < (0x86480 - 0x861D0) / 8; index++) {
        const entry = 0x861D0 + index * 8;
        const type = data.readUInt32BE(entry);
        if (type === 0) break;
        const pointer = data.readUInt32BE(entry + 4) & 0x000FFFFF;
        particleStyles.push({
            Type: type,
            RenderDescriptor: type === 1 ? (pointer - 0x85E40) / 0x10 : -1,
            CustomRenderFunction: type === 3 ? pointer : 0,
        });
    }
    // fragment62_31AA30.c's type-3 callbacks are mostly alternate quad
    // builders around a texture resource. Normalize their texture contract so
    // the viewer can use the same particle runtime; the original callback is
    // retained for orientation/special-material handling.
    const customTextureLayouts = new Map<number, [number, number, number, number, number, number, 'static' | 'global' | 'particle']>([
        [0x310A0, [0x13, 4, 0, 32, 96, 8, 'global']], [0x311D8, [0x13, 4, 0, 32, 96, 8, 'global']],
        [0x31314, [0x13, 4, 0, 32, 96, 8, 'global']], [0x31450, [0x13, 4, 0, 32, 96, 8, 'global']],
        [0x3157C, [0x13, 4, 0, 32, 96, 8, 'global']], [0x316A8, [0x13, 4, 0, 32, 96, 8, 'global']],
        [0x317D4, [0x1B, 4, 0, 16, 256, 1, 'static']], [0x318F8, [0x1B, 4, 0, 16, 256, 1, 'static']],
        [0x31A1C, [0x13, 4, 0, 32, 96, 8, 'global']], [0x31B58, [0x18, 4, 0, 32, 32, 8, 'particle']],
        [0x31C34, [0xA9, 4, 0, 32, 32, 1, 'static']], [0x30AF0, [0x19, 4, 0, 64, 64, 1, 'static']],
        [0x30B18, [0x5E, 4, 0, 64, 64, 1, 'static']], [0x30B40, [0x1A, 4, 0, 32, 32, 8, 'particle']],
        [0x30C70, [0x1C, 0, 2, 32, 32, 1, 'static']], [0x30D64, [0x1E, 0, 2, 32, 32, 1, 'static']],
        [0x30E58, [0xC3, 0, 2, 32, 32, 1, 'static']], [0x30F4C, [0x1D, 4, 0, 32, 32, 1, 'static']],
        [0x30388, [0x1F, 4, 0, 32, 64, 1, 'static']], [0x304AC, [0xBC, 0, 2, 32, 32, 1, 'static']],
        [0x30574, [0x27, 4, 0, 64, 64, 1, 'static']], [0x30688, [0x27, 4, 0, 64, 64, 1, 'static']],
        [0x3079C, [0x29, 4, 0, 32, 32, 1, 'static']], [0x30300, [0x76, 3, 1, 32, 64, 8, 'particle']],
        [0x30344, [0x76, 3, 1, 32, 64, 8, 'particle']], [0x30934, [0x87, 4, 0, 32, 32, 1, 'static']],
    ]);
    const customGeometry = new Map<number, [MoveEffectGeometryKind, boolean]>([
        [0x30300, ['center32', true]], [0x30344, ['center32', true]],
        [0x30574, ['screen320x240', false]], [0x30688, ['screen320x240Double', false]],
        [0x3079C, ['screen320x240Quarter', false]], [0x30934, ['screen320x240Quarter', false]],
        [0x30AF0, ['bottom128x64', false]], [0x30B18, ['bottom128x64', false]],
        [0x30B40, ['center32', false]], [0x30C70, ['center32', false]], [0x30D64, ['center32', false]],
        [0x30E58, ['center32', false]], [0x30F4C, ['center32', false]],
        [0x310A0, ['beam32', false]], [0x311D8, ['beam16', false]], [0x31314, ['beam8', false]],
        [0x31450, ['beam32', true]], [0x3157C, ['beam16', true]], [0x316A8, ['beam8', true]],
        [0x317D4, ['beamTriangle8', false]], [0x318F8, ['beamTriangle32', false]],
        [0x31A1C, ['tall96', false]], [0x31B58, ['center32', true]], [0x31C34, ['right32', false]],
    ]);
    const customDualTextures = new Map<number, [number, 'colorAndAlpha' | 'colorOnly', number, number, number, number]>([
        [0x30300, [0x77, 'colorOnly', 4, 0, 64, 64]], [0x30344, [0x77, 'colorOnly', 4, 0, 64, 64]],
        [0x30574, [0x28, 'colorAndAlpha', 4, 0, 64, 64]], [0x30688, [0x28, 'colorAndAlpha', 4, 0, 64, 64]],
        [0x3079C, [0x29, 'colorAndAlpha', 4, 0, 32, 32]],
    ]);
    const customGeometryResources = new Map<number, number>([
        [0x30388, 0x20], [0x304AC, 0xBD],
    ]);
    for (const style of particleStyles) {
        if (style.Type !== 3) continue;
        const layout = customTextureLayouts.get(style.CustomRenderFunction);
        if (layout === undefined) continue;
        const geometry = customGeometry.get(style.CustomRenderFunction) ?? ['center32', true] as const;
        const dualTexture = customDualTextures.get(style.CustomRenderFunction);
        style.RenderDescriptor = renderDescriptors.length;
        renderDescriptors.push({
            Flags: 1, TextureLoadFunction: 0, RenderFunction: style.CustomRenderFunction, ResourceID: layout[0],
            TextureFormat: layout[1], TextureSize: layout[2], Width: layout[3], Height: layout[4],
            TextureFrameCount: layout[5], TextureFrameMode: layout[6],
            GeometryKind: geometry[0], Billboard: geometry[1],
            GeometryResourceID: customGeometryResources.get(style.CustomRenderFunction) ?? -1,
            SecondaryResourceID: dualTexture?.[0] ?? -1,
            SecondaryTextureFormat: dualTexture?.[2] ?? 0, SecondaryTextureSize: dualTexture?.[3] ?? 0,
            SecondaryWidth: dualTexture?.[4] ?? 0, SecondaryHeight: dualTexture?.[5] ?? 0,
            DualTextureMode: dualTexture?.[1] ?? 'none',
        });
    }
    const resources = resourceBanks.flatMap((bank, archiveID) => parseMoveEffectResources(archiveID, bank));
    const attackerPrimitives = readPrimitives(attackerPrimitiveCount, 0x86480, 0x88280, 0x88668, 0x88A50);
    const targetPrimitives = readPrimitives(targetPrimitiveCount, 0x866C4, 0x884D8, 0x888C0, 0x88CA8);
    for (const primitive of [...attackerPrimitives, ...targetPrimitives]) for (const spawn of primitive.ParticleSpawns) {
        if (spawn.ParticleStyle !== -1) continue;
        const animationIDs = spawn.ModelResources.map((pair) => pair.AnimationResourceID).filter((id) => id >= 0);
        spawn.ModelAnimationFrameCount = Math.max(0, ...animationIDs.map((animationID) => resources.find((resource) =>
            resource.Type === 4 && resource.ResourceID === animationID)?.Animation?.FrameCount ?? 0));
    }
    return {
        MoveCount: moveCount,
        AttackerPrimitiveCount: attackerPrimitiveCount,
        TargetPrimitiveCount: targetPrimitiveCount,
        AttackerPrimitives: attackerPrimitives,
        TargetPrimitives: targetPrimitives,
        Resources: resources,
        RenderDescriptors: renderDescriptors,
        ParticleStyles: particleStyles,
        Scripts: scripts,
        MoveResultPrimitives: moveResultPrimitives,
        MoveResultResourceBanks: moveResultResourceBanks,
    };
}

function parseMaterialAnimations(data: Buffer, tableOffset: number | null, count: number): PokemonMaterialAnimation[] {
    if (tableOffset === null) return [];
    const animations: PokemonMaterialAnimation[] = [];
    for (let i = 0; i < count; i++) {
        const offset = fragmentOffset(data.readUInt32BE(tableOffset + i * 4), data)!;
        const channelCount = data.readUInt16BE(offset + 8);
        const channelsOffset = fragmentOffset(data.readUInt32BE(offset + 0x0C), data)!;
        const channels: PokemonMaterialAnimationChannel[] = [];
        for (let channel = 0; channel < channelCount; channel++) {
            channels.push({
                FrameCount: data.readUInt16BE(channelsOffset + channel * 4),
                FirstTextureIndex: data.readUInt16BE(channelsOffset + channel * 4 + 2),
            });
        }
        animations.push({
            Flags: data.readUInt16BE(offset), StartFrame: data.readInt16BE(offset + 4),
            LoopFrame: data.readInt16BE(offset + 6), ChannelCount: channelCount,
            FrameCount: data.readUInt16BE(offset + 0x0A),
            TextureIndicesOffset: fragmentOffset(data.readUInt32BE(offset + 0x10), data)!, Channels: channels,
        });
    }
    return animations;
}

function parseAnimationAt(data: Buffer, offset: number): PokemonAnimation {
        const channelCount = data.readUInt16BE(offset + 8);
        const tracksOffset = fragmentOffset(data.readUInt32BE(offset + 0x0C), data)!;
        const tracks: PokemonAnimationTrack[] = [];
        for (let channel = 0; channel < channelCount; channel++) {
            const track = tracksOffset + channel * 0x0A;
            tracks.push({
                ScaleCount: data[track], RotationCount: data[track + 1], TranslationCount: data[track + 2],
                Flags: data[track + 3], ScaleOffset: data.readUInt16BE(track + 4),
                RotationOffset: data.readUInt16BE(track + 6), TranslationOffset: data.readUInt16BE(track + 8),
            });
        }
        return {
            Flags: data.readUInt16BE(offset), StartFrame: data.readInt16BE(offset + 4),
            LoopFrame: data.readInt16BE(offset + 6), ChannelCount: channelCount,
            FrameCount: data.readUInt16BE(offset + 0x0A),
            ScaleValuesOffset: fragmentOffset(data.readUInt32BE(offset + 0x10), data)!,
            RotationValuesOffset: fragmentOffset(data.readUInt32BE(offset + 0x14), data)!,
            TranslationValuesOffset: fragmentOffset(data.readUInt32BE(offset + 0x18), data)!, Tracks: tracks,
        };
}

function parseAnimations(data: Buffer, tableOffset: number | null, count: number): PokemonAnimation[] {
    if (tableOffset === null) return [];
    const animations: PokemonAnimation[] = [];
    for (let i = 0; i < count; i++) {
        const offset = fragmentOffset(data.readUInt32BE(tableOffset + i * 4), data)!;
        animations.push(parseAnimationAt(data, offset));
    }
    return animations;
}

function parsePokemonMetadata(data: Buffer, rom: Buffer): PokemonMetadata {
    // Every model fragment's tiny entry function returns its descriptor with a
    // LUI / ADDIU pair. Reading this is deterministic and avoids emulating MIPS.
    const lui = data.readUInt32BE(0x2C), addiu = data.readUInt32BE(0x30);
    if ((lui >>> 26) !== 0x0F || (addiu >>> 26) !== 0x09)
        throw new Error('unsupported Pokémon fragment entry function');
    const signedLow = (addiu << 16) >> 16;
    const descriptorAddress = ((((lui & 0xFFFF) << 16) >>> 0) + signedLow) >>> 0;
    const descriptorOffset = fragmentOffset(descriptorAddress, data)!;
    const speciesID = data.readUInt16BE(descriptorOffset);
    const battleScale = rom.readInt16BE(0x76A40 + speciesID * 2) * 0.01;
    const variantCount = data.readUInt16BE(descriptorOffset + 2);
    const animationCount = data[descriptorOffset + 4];
    const materialAnimationCount = data[descriptorOffset + 5];
    const geoLayoutTable = fragmentOffset(data.readUInt32BE(descriptorOffset + 8), data)!;
    const geoLayouts: number[] = [];
    for (let i = 0; i < variantCount; i++)
        geoLayouts.push(fragmentOffset(data.readUInt32BE(geoLayoutTable + i * 4), data)!);
    const animationTableOffset = fragmentOffset(data.readUInt32BE(descriptorOffset + 0x0C), data, true);
    const materialAnimationTableOffset = fragmentOffset(data.readUInt32BE(descriptorOffset + 0x10), data, true);
    // fragment62's load_battle_actor_species_data DMA-loads this species' 0xB90-byte battle
    // animation map from segment 0x70D3A0. Each of the 165 move records is
    // 0x10 bytes and byte zero selects the model's skeletal animation.
    const battleAnimationMap = 0x70D3A0 + (speciesID - 1) * 0xB90;
    // Battle code indexes this array with moveID - 1.
    const moveRecord = (moveIndex: number): number => battleAnimationMap + moveIndex * 0x10;
    const moveAnimationIDs = Array.from({ length: 165 }, (_, move) => rom[moveRecord(move)]);
    // get_move_effect_primary_attachment / secondary_attachment read bytes
    // two and three as the primary and optional secondary effect joints.
    const moveEffectAttachmentIDs = Array.from({ length: 165 }, (_, move) =>
        [rom[moveRecord(move) + 2], rom[moveRecord(move) + 3]]
            .filter((attachmentID) => attachmentID !== 0xFF));
    // The battle controller starts the move effect when the model animation
    // reaches byte four of this record (fragment62 compares frame + 1).
    const moveEffectStartFrames = Array.from({ length: 165 }, (_, move) =>
        rom[moveRecord(move) + 4]);
    const moveAnimationFrequencies = moveAnimationIDs.map((animationID, move) => {
        let count = 0;
        for (let candidateSpecies = 1; candidateSpecies <= 151; candidateSpecies++) {
            const candidateMap = 0x70D3A0 + (candidateSpecies - 1) * 0xB90;
            if (rom[candidateMap + move * 0x10] === animationID) count++;
        }
        return count;
    });
    // Stadium's maximum-level move eligibility check combines the species'
    // initial moves, its level-up table, two recorded pre-evolutions' initial
    // moves, and the 55 TM/HM compatibility bits in the base species record.
    const tmMoveIDs = Array.from({ length: 55 }, (_, i) => rom[0x375874 + i]);
    const speciesRecordOffset = (id: number): number => 0x71BA0 + (id - 1) * 0x17;
    const addSpeciesMoves = (moves: Set<number>, id: number, includeLevelUp: boolean): void => {
        const record = speciesRecordOffset(id);
        for (let i = 0; i < 4; i++) {
            const moveID = rom[record + 0x0A + i];
            if (moveID !== 0) moves.add(moveID);
        }
        if (includeLevelUp) {
            const learnset = 0x77FB20 + (id - 1) * 0x20;
            for (let i = 0; i < 10 && rom[learnset + i] !== 0; i++) {
                const moveID = rom[learnset + 0x0A + i];
                if (moveID !== 0) moves.add(moveID);
            }
        }
    };
    // Keep the species' own learnset separate and in game order. LegalMoveIDs
    // also contains inherited starting moves and TM/HMs, which makes a poor
    // source for choosing a move to demonstrate each shared model animation.
    const naturalMoves = new Set<number>();
    addSpeciesMoves(naturalMoves, speciesID, true);
    const naturalMoveIDs = [...naturalMoves].filter((moveID) => moveID <= 165);
    const legalMoves = new Set<number>(naturalMoveIDs);
    const preEvolutionRecord = 0x77F1B0 + (speciesID - 1) * 0x10;
    for (let i = 0; i < 2; i++) {
        const preEvolutionID = rom[preEvolutionRecord + i];
        if (preEvolutionID !== 0) addSpeciesMoves(legalMoves, preEvolutionID, false);
    }
    const compatibilityOffset = speciesRecordOffset(speciesID) + 0x0F;
    const tmCompatibility = Buffer.from(rom.subarray(compatibilityOffset, compatibilityOffset + 7));
    // can_species_learn_tm_hm patches four omissions in the stored final
    // compatibility byte.
    if (speciesID === 0x06) tmCompatibility[6] |= 0x08;
    if (speciesID === 0x0C || speciesID === 0x30 || speciesID === 0x31) tmCompatibility[6] |= 0x40;
    if (speciesID === 0x32 || speciesID === 0x33 || speciesID === 0x8D) tmCompatibility[6] |= 0x04;
    for (let tm = 0; tm < tmMoveIDs.length; tm++)
        if ((tmCompatibility[tm >>> 3] & (1 << (tm & 7))) !== 0 && tmMoveIDs[tm] !== 0) legalMoves.add(tmMoveIDs[tm]);
    const legalMoveIDs = [...legalMoves].filter((moveID) => moveID <= 165).sort((a, b) => a - b);
    // These named slots are selected by the battle controller for generic hit,
    // recoil, faint, and related reaction states rather than by a move ID.
    const reactionAnimationIDs = [0xA50, 0xA70, 0xA80, 0xAF0, 0xB00, 0xB10, 0xB20]
        .map((offset) => rom[battleAnimationMap + offset]).filter((id, i, ids) => id !== 0xFF && ids.indexOf(id) === i);
    return {
        SpeciesID: speciesID, BattleScale: battleScale, VariantCount: variantCount, AnimationCount: animationCount,
        MaterialAnimationCount: materialAnimationCount, DescriptorOffset: descriptorOffset, GeoLayouts: geoLayouts,
        DisplayLists: collectGeoDisplayLists(data, geoLayouts),
        GeoNodes: geoLayouts.map((layout) => parseGeoLayout(data, layout)),
        Animations: parseAnimations(data, animationTableOffset, animationCount),
        MaterialAnimations: parseMaterialAnimations(data, materialAnimationTableOffset, materialAnimationCount),
        AnimationTableOffset: animationTableOffset,
        MaterialAnimationTableOffset: materialAnimationTableOffset,
        MoveAnimationIDs: moveAnimationIDs, MoveAnimationFrequencies: moveAnimationFrequencies,
        MoveEffectAttachmentIDs: moveEffectAttachmentIDs, MoveEffectStartFrames: moveEffectStartFrames,
        NaturalMoveIDs: naturalMoveIDs, LegalMoveIDs: legalMoveIDs,
        ReactionAnimationIDs: reactionAnimationIDs,
    };
}

function extractArchive(rom: Buffer, outputRoot: string, spec: ArchiveSpec): number {
    const blob = rom.subarray(spec.romStart, spec.romEnd);
    const totalSize = blob.readUInt32BE(8);
    const count = blob.readUInt32BE(0x0C);
    if (totalSize > blob.length || 0x10 + count * 0x10 > totalSize)
        throw new Error(`invalid ${spec.kind} archive header`);
    const directory = join(outputRoot, spec.kind);
    mkdirSync(directory, { recursive: true });
    for (let id = 0; id < count; id++) {
        const descriptor = 0x10 + id * 0x10;
        const offset = blob.readUInt32BE(descriptor);
        const size = blob.readUInt32BE(descriptor + 4);
        const { data, compression, relocations } = extractEntry(blob, offset, size);
        const fragment = parseFragment(data);
        let pokemon: PokemonMetadata | undefined;
        let stadium: StadiumMetadata | undefined;
        try {
            pokemon = spec.kind === 'pokemon' ? parsePokemonMetadata(data, rom) : undefined;
            stadium = spec.kind === 'stadium' ? parseStadiumMetadata(data) : undefined;
        } catch (error) {
            throw new Error(`failed to parse ${spec.kind} archive entry ${id}`, { cause: error });
        }
        if (fragment !== undefined) normalizeFragmentPointers(data, fragment);
        const archive: ModelArchive = {
            Kind: spec.kind, ID: id, SourceROMOffset: spec.romStart + offset, Compression: compression,
            Relocations: relocations, Data: ArrayBufferSlice.fromView(data),
            Fragment: fragment, Pokemon: pokemon, Stadium: stadium,
        };
        const byml = BYML.write(archive, BYML.FileType.CRG1);
        writeFileSync(join(directory, `${hex(id, spec.digits)}.crg1`), zstdCompressSync(new Uint8Array(byml)));
    }
    return count;
}

function extractMoveEffects(rom: Buffer, outputRoot: string): void {
    const romStart = 0x2EA8C0;
    const header = rom.subarray(romStart, romStart + 0x20);
    const fragment = parseFragment(header);
    if (fragment === undefined) throw new Error('battle effect fragment is missing its FRAGMENT header');
    const data = Buffer.alloc(fragment.SizeInRAM);
    rom.copy(data, 0, romStart, romStart + fragment.SizeInROM);
    normalizeFragmentPointers(data, fragment);
    // The relocation stream occupies the ROM tail beginning at RelocOffset;
    // the overlay loader does not expose those bytes at runtime. That address
    // range is the fragment's zero-initialized globals (including the model
    // particle allocation pools) once relocation has completed.
    data.fill(0, fragment.RelocOffset);

    // PokemonModelArchives_Init loads archive 0x8CC000, entry zero for battle
    // effects. It contains the texture/model resource list consumed by
    // load_model_resource_list(0), and is required in addition to fragment 62 itself.
    const resourceArchive = rom.subarray(0x8CC000, 0x920000);
    const resourceBankCount = resourceArchive.readUInt32BE(0x0C);
    const resourceBanks: Buffer[] = [];
    for (let archiveID = 0; archiveID < resourceBankCount; archiveID++) {
        const descriptor = 0x10 + archiveID * 0x10;
        const resourceOffset = resourceArchive.readUInt32BE(descriptor);
        const resourceSize = resourceArchive.readUInt32BE(descriptor + 4);
        resourceBanks.push(extractEntry(resourceArchive, resourceOffset, resourceSize).data);
    }
    const archive: ModelArchive = {
        Kind: 'move-effects', ID: 0, SourceROMOffset: romStart, Compression: 'raw', Relocations: [],
        Data: ArrayBufferSlice.fromView(data), Fragment: fragment,
        MoveEffects: parseMoveEffectMetadata(data, resourceBanks),
        MoveEffectResourceBanks: resourceBanks.map((bank, ArchiveID) => ({ ArchiveID, Data: ArrayBufferSlice.fromView(bank) })),
    };
    const byml = BYML.write(archive, BYML.FileType.CRG1);
    writeFileSync(join(outputRoot, 'move-effects.crg1'), zstdCompressSync(new Uint8Array(byml)));
}

function extractBattleText(rom: Buffer, outputRoot: string): void {
    const archiveOffset = 0x783760;
    const file = (fileID: number): string[] => {
        const descriptor = archiveOffset + 0x10 + fileID * 0x10;
        const offset = rom.readUInt32BE(descriptor);
        const size = rom.readUInt32BE(descriptor + 4);
        const data = rom.subarray(archiveOffset + offset, archiveOffset + offset + size);
        const count = data.readUInt32BE(0);
        if ((count + 2) * 4 > data.length) throw new Error(`invalid text bank 0x${fileID.toString(16)}`);
        const decode = (bytes: Buffer): string => {
            let text = '';
            for (const byte of bytes) {
                // Stadium's font assigns these two single-byte glyphs to the
                // Nidoran gender symbols; the remaining battle labels are ASCII.
                text += byte === 0xBE ? '♀' : byte === 0xA9 ? '♂' : String.fromCharCode(byte);
            }
            return text;
        };
        return Array.from({ length: count }, (_, index) => {
            const start = data.readUInt32BE((index + 1) * 4);
            const end = data.indexOf(0, start);
            if (start < 0 || start >= data.length || end < start) throw new Error(`invalid string ${index} in text bank 0x${fileID.toString(16)}`);
            return decode(data.subarray(start, end));
        });
    };
    const fontArchiveOffset = 0x3BA190;
    const fontDescriptor = fontArchiveOffset + 0x10;
    const fontOffset = rom.readUInt32BE(fontDescriptor);
    const fontSize = rom.readUInt32BE(fontDescriptor + 4);
    const font = extractEntry(rom, fontArchiveOffset + fontOffset, fontSize).data;
    const glyphWidth = 0x10, glyphHeight = 0x0A, glyphCount = 0x90;
    const glyphDataOffset = glyphCount;
    if (font.length < glyphDataOffset + glyphWidth * glyphHeight * glyphCount)
        throw new Error('battle font archive is truncated');

    const battleUI = extractEntry(rom, 0x6E2FC0, 0x6E8910 - 0x6E2FC0).data;
    const borderOffsets = [0x8480, 0x8400, 0x8600, 0x8580, 0x8500, 0x8380, 0x8700, 0x8680];
    const borderTiles = borderOffsets.map((offset) => ArrayBufferSlice.fromView(battleUI.subarray(offset, offset + 8 * 8 * 2)));
    // D_8006F650 maps the two printable byte ranges (0x20-0x7F and
    // 0xA0-0xFF) to the font archive's glyph indices.
    const characterMap = [...rom.subarray(0x70250, 0x70250 + 0xC0)];
    const battleMessages = file(0x1E);
    // Guaranteed move outcomes used by the standalone animation exhibit. The
    // values are indices in the game's battle-message bank, not replacement
    // strings. Probabilistic secondary effects are deliberately omitted.
    const moveResultMessageIDs = new Array<number>(166).fill(-1);
    const resultMessages: [number, number][] = [
        [14, 0x45], [28, 0x5C], [39, 0x59], [43, 0x59], [45, 0x58],
        [47, 0x39], [48, 0x72], [54, 0x6E], [73, 0x7A], [74, 0x4E],
        [77, 0x3C], [78, 0x75], [79, 0x39], [81, 0x5A],
        [86, 0x75], [92, 0x3B], [95, 0x39], [96, 0x4B], [97, 0x47],
        [103, 0x53], [104, 0x50], [105, 0x85], [106, 0x4C], [107, 0x50],
        [108, 0x5C], [109, 0x72], [110, 0x4C], [111, 0x4C], [112, 0x46],
        [113, 0x8A], [114, 0x82], [115, 0x8C], [116, 0x70], [133, 0x48],
        [134, 0x5C], [135, 0x85], [137, 0x75], [142, 0x39], [147, 0x39],
        [148, 0x5C], [151, 0x46], [156, 0x83], [159, 0x4B], [160, 0x80], [164, 0x90],
    ];
    for (const [moveID, messageID] of resultMessages) moveResultMessageIDs[moveID] = messageID;
    const archive: PokemonStadiumBattleTextArchive = {
        Kind: 'battle-text',
        PokemonNames: file(0x24),
        MoveNames: file(0x25),
        BattleMessages: battleMessages,
        MoveResultMessageIDs: moveResultMessageIDs,
        UsedMoveTemplate: battleMessages[0x19],
        Font: {
            GlyphWidth: glyphWidth, GlyphHeight: glyphHeight,
            Widths: [...font.subarray(0, glyphCount)], CharacterMap: characterMap,
            Glyphs: ArrayBufferSlice.fromView(font.subarray(glyphDataOffset, glyphDataOffset + glyphWidth * glyphHeight * glyphCount)),
        },
        BorderTiles: borderTiles,
    };
    if (archive.PokemonNames.length !== 151 || archive.MoveNames.length !== 165 || archive.UsedMoveTemplate !== '#25 used #29!')
        throw new Error('unexpected Pokémon Stadium battle text tables');
    const byml = BYML.write(archive, BYML.FileType.CRG1);
    writeFileSync(join(outputRoot, 'battle-text.crg1'), zstdCompressSync(new Uint8Array(byml)));
}

const romPath = process.argv[2];
if (romPath === undefined)
    throw new Error('usage: node --import tsx src/PokemonStadium/tools/extractor.ts <Pokemon Stadium (USA 1.0).z64> [output directory]');
const outputRoot = process.argv[3] ?? './data/PokemonStadium';
const rom = readFileSync(romPath);
const sha1 = createHash('sha1').update(rom).digest('hex');
if (sha1 !== EXPECTED_SHA1) throw new Error(`unsupported ROM (SHA-1 ${sha1})`);
mkdirSync(outputRoot, { recursive: true });
const manifest = archiveSpecs.map((spec) => ({ Kind: spec.kind, Count: extractArchive(rom, outputRoot, spec) }));
extractMoveEffects(rom, outputRoot);
manifest.push({ Kind: 'move-effects', Count: 1 });
extractBattleText(rom, outputRoot);
manifest.push({ Kind: 'battle-text', Count: 1 });
writeFileSync(join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Extracted ${manifest.map((v) => `${v.Count} ${v.Kind} models`).join(' and ')}`);
