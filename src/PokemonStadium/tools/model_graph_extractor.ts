import type { PokemonGeoNode, PokemonTextureDescriptor, StadiumMetadata } from '../archive.js';
import { fragmentOffset } from './extractor_common.js';

const geoCommandSizes = [
    0x08, 0x04, 0x08, 0x08, 0x04, 0x04, 0x04, 0x08, 0x0C, 0x04, 0x08, 0x18, 0x04,
    0x04, 0x04, 0x04, 0x04, 0x04, 0x04, 0x08, 0x0C, 0x0C, 0x04, 0x14, 0x08, 0x08,
    0x04, 0x10, 0x10, 0x1C, 0x08, 0x18, 0x14, 0x10, 0x08, 0x10, 0x04, 0x04, 0x14,
];

// Stadium 2 adds two aligned standalone graph words after Stadium 1's table.
// They carry no renderer-facing payload but remain part of graph traversal.
function geoCommandSize(command: number): number | undefined {
    if (command === 0x28 || command === 0x29) return 0x04;
    return geoCommandSizes[command];
}

export function collectGeoDisplayLists(data: Buffer, starts: number[]): number[] {
    const displayLists = new Set<number>();
    const active = new Set<number>();
    const visited = new Set<number>();
    const walk = (start: number): void => {
        if (active.has(start) || visited.has(start)) return;
        active.add(start);
        let cursor = start;
        for (let commands = 0; commands < 0x10000; commands++) {
            if (cursor >= data.length) throw new Error(`geo layout outside fragment at 0x${cursor.toString(16)}`);
            const command = data[cursor];
            const size = geoCommandSize(command);
            if (size === undefined) throw new Error(`unknown geo command 0x${command.toString(16)} at 0x${cursor.toString(16)}`);
            visited.add(cursor);
            if (command === 0x00 || command === 0x03) {
                walk(fragmentOffset(data.readUInt32BE(cursor + 4), data)!);
            } else if (command === 0x02) {
                cursor = fragmentOffset(data.readUInt32BE(cursor + 4), data)!;
                continue;
            } else if (command === 0x01 || command === 0x04) {
                break;
            } else {
                const pointerOffset = command === 0x1E || command === 0x22 || command === 0x23 ? 4
                    : command === 0x20 ? 0x10 : command === 0x21 ? 0x0C : -1;
                if (pointerOffset >= 0) {
                    const address = data.readUInt32BE(cursor + pointerOffset);
                    const displayList = fragmentOffset(address, data, true);
                    if (displayList !== null) displayLists.add(displayList);
                }
            }
            cursor += size;
        }
        active.delete(start);
    };
    for (const start of starts) walk(start);
    // Preserve scene-graph traversal order. Material setup nodes deliberately
    // precede geometry nodes and their RSP state carries across display lists.
    return [...displayLists];
}

export function parseGeoLayout(data: Buffer, start: number): PokemonGeoNode[] {
    const nodes: PokemonGeoNode[] = [];
    const branchReturnStack: number[] = [];
    const callStack: { cursor: number; depth: number }[] = [];
    const currentNodeAtDepth: number[] = [-1];
    let depth = 0;
    let cursor = start;

    const makeNode = (command: number): PokemonGeoNode => ({
        SourceOffset: cursor, Command: command, Parent: depth === 0 ? -1 : currentNodeAtDepth[depth - 1], Layer: -1, DisplayList: -1,
        Translation: [0, 0, 0], Rotation: [0, 0, 0], Scale: [1, 1, 1],
        TextureIndex: -1, PaletteIndex: -1, MaterialFlags: 0, Color: 0xFFFFFFFF,
        AnimationChannel: -1, MaterialAnimationChannel: -1, MatrixSlot: -1, TransformMode: 1,
        Textures: [], Palettes: [], LightColor: [0, 0, 0, 0], LightAngles: [0, 0],
            DrawCallback: 0, DrawCallbackCommandOffset: -1, DrawCallbackArgument: -1, DrawCallbackRawArgument: 0,
            VertexArrayOffset: -1, VertexCount: 0,
        AttachmentID: -1,
    });
    const pointer = (offset: number): number => fragmentOffset(data.readUInt32BE(offset), data, true) ?? -1;
    const resourcePointer = (offset: number): number => {
        const address = data.readUInt32BE(offset);
        // A handful of non-roster effect models refer to shared engine assets.
        // Those are not part of this fragment and cannot be archived here.
        if (address !== 0 && ((address & 0xFFF00000) >>> 0) !== 0x8FF00000) return -1;
        return fragmentOffset(address, data, true) ?? -1;
    };

    for (let commands = 0; commands < 0x10000; commands++) {
        if (cursor >= data.length) throw new Error(`geo layout outside fragment at 0x${cursor.toString(16)}`);
        const command = data[cursor];
        const size = geoCommandSize(command);
        if (size === undefined) throw new Error(`unknown geo command 0x${command.toString(16)} at 0x${cursor.toString(16)}`);

        if (command === 0x00) {
            callStack.push({ cursor: cursor + size, depth });
            cursor = fragmentOffset(data.readUInt32BE(cursor + 4), data)!;
            continue;
        } else if (command === 0x03) {
            branchReturnStack.push(cursor + size);
            cursor = fragmentOffset(data.readUInt32BE(cursor + 4), data)!;
            continue;
        } else if (command === 0x02) {
            cursor = fragmentOffset(data.readUInt32BE(cursor + 4), data)!;
            continue;
        } else if (command === 0x04) {
            if (branchReturnStack.length === 0) break;
            cursor = branchReturnStack.pop()!;
            continue;
        } else if (command === 0x01) {
            if (callStack.length === 0) break;
            const frame = callStack.pop()!;
            cursor = frame.cursor;
            depth = frame.depth;
            continue;
        } else if (command === 0x05) {
            currentNodeAtDepth[depth + 1] = currentNodeAtDepth[depth];
            depth++;
            cursor += size;
            continue;
        } else if (command === 0x06) {
            depth--;
            cursor += size;
            continue;
        }

        if (command === 0x08) {
            const current = currentNodeAtDepth[depth];
            if (current >= 0) {
                nodes[current].DrawCallback = data.readUInt32BE(cursor + 4);
                nodes[current].DrawCallbackCommandOffset = cursor;
                nodes[current].DrawCallbackRawArgument = data.readUInt32BE(cursor + 8);
                nodes[current].DrawCallbackArgument = resourcePointer(cursor + 8);
            }
            cursor += size;
            continue;
        }

        // Commands 12, 15 and 25 modify or skip an existing graph node.
        if (command !== 0x08 && command !== 0x12 && command !== 0x15 && command !== 0x25) {
            const node = makeNode(command);
            if (command === 0x14) {
                node.LightAngles = [data.readInt16BE(cursor + 4), data.readInt16BE(cursor + 6)]
                    .map((angle) => angle * 360 / 0x10000);
                node.LightColor = [data[cursor + 8], data[cursor + 9], data[cursor + 0x0A], data[cursor + 0x0B]];
            } else if (command === 0x16) {
                node.LightColor = [data[cursor + 1], data[cursor + 2], data[cursor + 3], 0xFF];
            } else if (command === 0x17) {
                const textureCount = data.readUInt16BE(cursor + 2);
                const paletteCount = data.readUInt16BE(cursor + 4);
                const texturesOffset = pointer(cursor + 8);
                const palettesOffset = pointer(cursor + 0x0C);
                const parseDescriptors = (destination: PokemonTextureDescriptor[], descriptorOffset: number, count: number): void => {
                    for (let i = 0; i < count; i++) {
                        const descriptor = descriptorOffset + i * 0x0C;
                        destination.push({
                        Format: data[descriptor], Size: data[descriptor + 1],
                        Width: data.readInt16BE(descriptor + 2), Height: data.readInt16BE(descriptor + 4),
                        TexelCount: data.readInt16BE(descriptor + 6), DataOffset: resourcePointer(descriptor + 8),
                    });
                    }
                };
                if (texturesOffset >= 0) parseDescriptors(node.Textures, texturesOffset, textureCount);
                if (palettesOffset >= 0) parseDescriptors(node.Palettes, palettesOffset, paletteCount);
                node.VertexCount = data.readInt16BE(cursor + 6);
                node.VertexArrayOffset = pointer(cursor + 0x10);
            } else if (command === 0x1B) {
                node.Rotation = [data.readInt16BE(cursor + 4), data.readInt16BE(cursor + 6), data.readInt16BE(cursor + 8)];
                node.Translation = [data.readInt16BE(cursor + 0x0A), data.readInt16BE(cursor + 0x0C), data.readInt16BE(cursor + 0x0E)];
            } else if (command === 0x1C) {
                node.Scale = [data.readInt32BE(cursor + 4) / 0x10000, data.readInt32BE(cursor + 8) / 0x10000, data.readInt32BE(cursor + 0x0C) / 0x10000];
            } else if (command === 0x1D) {
                node.MatrixSlot = data[cursor + 1];
                node.TransformMode = (data[cursor + 2] & 1 ? 0 : 1) | (data[cursor + 2] & 2);
                node.AnimationChannel = data[cursor + 3];
                node.Translation = [data.readInt16BE(cursor + 4), data.readInt16BE(cursor + 6), data.readInt16BE(cursor + 8)];
                node.Rotation = [data.readInt16BE(cursor + 0x0A), data.readInt16BE(cursor + 0x0C), data.readInt16BE(cursor + 0x0E)]
                    .map((angle) => angle * 360 / 0x10000);
                node.Scale = [data.readInt32BE(cursor + 0x10) / 0x10000, data.readInt32BE(cursor + 0x14) / 0x10000, data.readInt32BE(cursor + 0x18) / 0x10000];
            } else if (command === 0x1E || command === 0x22) {
                node.Layer = data[cursor + 1];
                if (command === 0x1E) node.MatrixSlot = data.readInt16BE(cursor + 2);
                node.DisplayList = pointer(cursor + 4);
            } else if (command === 0x20) {
                node.Layer = data[cursor + 1];
                node.Rotation = [data.readInt16BE(cursor + 4), data.readInt16BE(cursor + 6), data.readInt16BE(cursor + 8)];
                node.Translation = [data.readInt16BE(cursor + 0x0A), data.readInt16BE(cursor + 0x0C), data.readInt16BE(cursor + 0x0E)];
                node.DisplayList = pointer(cursor + 0x10);
            } else if (command === 0x21) {
                node.Layer = data[cursor + 1];
                node.Translation = [data.readInt16BE(cursor + 2), data.readInt16BE(cursor + 4), data.readInt16BE(cursor + 6)];
                node.Scale = [data.readInt32BE(cursor + 8) / 0x10000, data.readInt32BE(cursor + 8) / 0x10000, data.readInt32BE(cursor + 8) / 0x10000];
                node.DisplayList = pointer(cursor + 0x0C);
            } else if (command === 0x23) {
                node.MaterialFlags = data[cursor + 1];
                node.MaterialAnimationChannel = data.readInt16BE(cursor + 2);
                node.DisplayList = pointer(cursor + 4);
                node.TextureIndex = data.readInt16BE(cursor + 8);
                node.PaletteIndex = data.readInt16BE(cursor + 0x0A);
                node.Color = data.readUInt32BE(cursor + 0x0C);
            } else if (command === 0x24) {
                // GeoLayoutCommand_CreateAttachment creates graph-node type 0x1B; while the model
                // is drawn, GraphNode_RenderAttachment records the current matrix origin
                // under this authored attachment ID for move effects.
                node.AttachmentID = data.readInt16BE(cursor + 2);
            }
            nodes.push(node);
            currentNodeAtDepth[depth] = nodes.length - 1;
        }
        cursor += size;
    }
    return nodes;
}

export function evaluateFragmentEntry(data: Buffer, arg0: number, arg1: number): number {
    const r = new Uint32Array(32);
    r[4] = arg0 >>> 0; r[5] = arg1 >>> 0; r[31] = 0xFFFFFFFF;
    let pc = 0x20;
    const addressOffset = (address: number): number => address & 0x000FFFFF;
    const execute = (instruction: number): number | null => {
        const opcode = instruction >>> 26, rs = instruction >>> 21 & 0x1F, rt = instruction >>> 16 & 0x1F;
        const rd = instruction >>> 11 & 0x1F, shamt = instruction >>> 6 & 0x1F, fn = instruction & 0x3F;
        const immediate = instruction & 0xFFFF, signed = (immediate << 16) >> 16;
        if (opcode === 0) {
            if (fn === 0x00) r[rd] = r[rt] << shamt;
            else if (fn === 0x21) r[rd] = (r[rs] + r[rt]) >>> 0;
            else if (fn === 0x25) r[rd] = (r[rs] | r[rt]) >>> 0;
            else if (fn === 0x08) return r[rs];
        } else if (opcode === 0x09) r[rt] = (r[rs] + signed) >>> 0;
        else if (opcode === 0x0B) r[rt] = r[rs] < immediate ? 1 : 0;
        else if (opcode === 0x0D) r[rt] = (r[rs] | immediate) >>> 0;
        else if (opcode === 0x0F) r[rt] = (immediate << 16) >>> 0;
        else if (opcode === 0x23) {
            const offset = addressOffset((r[rs] + signed) >>> 0);
            if (offset + 4 > data.length) throw new Error('stadium entry load outside fragment');
            r[rt] = data.readUInt32BE(offset);
        }
        r[0] = 0;
        return null;
    };
    for (let steps = 0; steps < 256; steps++) {
        if (pc + 8 > data.length) throw new Error('stadium entry ran outside fragment');
        const instruction = data.readUInt32BE(pc);
        const opcode = instruction >>> 26, rs = instruction >>> 21 & 0x1F, rt = instruction >>> 16 & 0x1F;
        let target: number | null = null;
        if (opcode === 0x04 && r[rs] === r[rt]) target = pc + 4 + (((instruction & 0xFFFF) << 16 >> 14));
        else if (opcode === 0x05 && r[rs] !== r[rt]) target = pc + 4 + (((instruction & 0xFFFF) << 16 >> 14));
        else if (opcode === 0x02) target = ((pc + 4) & 0xF0000000) | ((instruction & 0x03FFFFFF) << 2);
        else if (opcode === 0 && (instruction & 0x3F) === 0x08) target = r[rs];
        else execute(instruction);
        if (target !== null) {
            execute(data.readUInt32BE(pc + 4));
            if (target === 0xFFFFFFFF) return r[2] >>> 0;
            pc = addressOffset(target);
        } else pc += 4;
    }
    throw new Error('stadium entry did not return');
}

export function parseStadiumMetadata(data: Buffer): StadiumMetadata {
    // Stadium fragment entry points are small switch functions whose return
    // values are geo-layout pointers. Symbolically evaluate their straight-line
    // instructions; this covers both LUI/ADDIU directly into v0 and the common
    // LUI/ADDIU into v1 followed by `move v0, v1` return path.
    const registers: (number | undefined)[] = new Array(32).fill(undefined);
    registers[0] = 0;
    const returnedPointers = new Set<number>();
    const scanEnd = Math.min(data.length, 0x200);
    for (let offset = 0x20; offset + 4 <= scanEnd; offset += 4) {
        const instruction = data.readUInt32BE(offset);
        const opcode = instruction >>> 26;
        const rs = instruction >>> 21 & 0x1F;
        const rt = instruction >>> 16 & 0x1F;
        const rd = instruction >>> 11 & 0x1F;
        const immediate = instruction & 0xFFFF;
        const signedImmediate = (immediate << 16) >> 16;
        if (opcode === 0x0F) {
            registers[rt] = (immediate << 16) >>> 0;
        } else if (opcode === 0x09 && registers[rs] !== undefined) {
            registers[rt] = (registers[rs]! + signedImmediate) >>> 0;
        } else if (opcode === 0x0D && registers[rs] !== undefined) {
            registers[rt] = (registers[rs]! | immediate) >>> 0;
        } else if (opcode === 0 && ((instruction & 0x3F) === 0x21 || (instruction & 0x3F) === 0x25)) {
            const lhs = registers[rs], rhs = registers[rt];
            registers[rd] = lhs !== undefined && rhs !== undefined ? (lhs + rhs) >>> 0 : undefined;
        }
        const value = registers[2];
        if (value !== undefined && ((value & 0xFFF00000) >>> 0) === 0x8FF00000)
            returnedPointers.add(value);
    }

    const geoLayouts: number[] = [];
    const geoNodes: PokemonGeoNode[][] = [];
    for (const address of returnedPointers) {
        const layout = fragmentOffset(address, data, true);
        if (layout === null || layout >= data.length || geoLayouts.includes(layout)) continue;
        try {
            const nodes = parseGeoLayout(data, layout);
            if (nodes.length === 0) continue;
            geoLayouts.push(layout);
            geoNodes.push(nodes);
        } catch {
            // Entry functions also return non-layout resources. Only validated
            // graph roots belong in the scene metadata.
        }
    }
    if (geoLayouts.length === 0) throw new Error('stadium fragment entry returned no geo layouts');
    return {
        GeoLayouts: geoLayouts, DisplayLists: collectGeoDisplayLists(data, geoLayouts), GeoNodes: geoNodes,
        Background: evaluateFragmentEntry(data, 2, 0),
    };
}
