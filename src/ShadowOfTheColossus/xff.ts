import ArrayBufferSlice from '../ArrayBufferSlice.js';

// Legacy xff\0 loader. XFF2 program modules have additional dynamic-linker
// behavior and are intentionally outside this parser's scope.

const HEADER_SIZE = 0x70;
const SECTION_SIZE = 0x20;
const SYMBOL_SIZE = 0x10;
const RELOCATION_TABLE_SIZE = 0x1C;
const SHT_NOBITS = 8;
const SHN_UNDEF = 0;
const SHN_ABS = 0xFFF1;

export interface XffSection {
    name: string;
    size: number;
    type: number;
    fileOffset: number;
    imageOffset: number;
}

export interface RelocatedXff {
    image: ArrayBufferSlice;
    entryOffset: number;
    sections: XffSection[];
    relocationCount: number;
    unresolvedSymbols: string[];
}

function align(value: number, alignment: number): number {
    if (alignment <= 1)
        return value;
    if ((alignment & (alignment - 1)) !== 0)
        throw new Error(`Invalid XFF alignment 0x${alignment.toString(16)}`);
    return Math.ceil(value / alignment) * alignment;
}

function range(byteLength: number, offset: number, size: number, what: string): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || size < 0 || offset + size > byteLength)
        throw new Error(`${what} exceeds legacy XFF image`);
}

function cstring(bytes: Uint8Array, offset: number): string {
    if (offset < 0 || offset >= bytes.length)
        throw new Error('Invalid legacy XFF string offset');
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    if (end === bytes.length)
        throw new Error('Unterminated legacy XFF string');
    return String.fromCharCode(...bytes.subarray(offset, end));
}

function setPointer(view: DataView, field: number, offset: number): void {
    view.setUint32(field, offset, true);
}

/** Relocate one self-contained legacy xff\0 module into an offset-addressed image. */
export function relocateLegacyXff(input: ArrayBufferSlice): RelocatedXff {
    const source = input.createTypedArray(Uint8Array);
    const serialized = input.createDataView();
    range(source.length, 0, HEADER_SIZE, 'Legacy XFF header');
    if (String.fromCharCode(...source.subarray(0, 4)) !== 'xff\0')
        throw new Error('Expected a legacy xff\\0 module (XFF2 is not supported here)');

    const declaredSize = serialized.getUint32(0x14, true);
    const symbolCount = serialized.getUint32(0x24, true);
    const relocationTableCount = serialized.getUint32(0x38, true);
    const sectionCount = serialized.getUint32(0x40, true);
    const symbolTable = serialized.getUint32(0x54, true);
    const symbolStrings = serialized.getUint32(0x58, true);
    const sectionTable = serialized.getUint32(0x5C, true);
    const symbolValues = serialized.getUint32(0x60, true);
    const relocationTables = serialized.getUint32(0x64, true);
    const sectionNameOffsets = serialized.getUint32(0x68, true);
    const sectionStrings = serialized.getUint32(0x6C, true);
    if (declaredSize < HEADER_SIZE || declaredSize > source.length)
        throw new Error('Invalid legacy XFF declared size');
    range(declaredSize, sectionTable, sectionCount * SECTION_SIZE, 'XFF section table');
    range(declaredSize, symbolTable, symbolCount * SYMBOL_SIZE, 'XFF symbol table');
    range(declaredSize, symbolValues, symbolCount * 4, 'XFF symbol values');
    range(declaredSize, relocationTables,
        relocationTableCount * RELOCATION_TABLE_SIZE, 'XFF relocation tables');
    range(declaredSize, sectionNameOffsets, sectionCount * 4, 'XFF section names');

    let imageSize = declaredSize;
    const sections: XffSection[] = [];
    for (let i = 0; i < sectionCount; i++) {
        const at = sectionTable + i * SECTION_SIZE;
        const size = serialized.getUint32(at + 8, true);
        const alignment = serialized.getUint32(at + 0x0C, true) || 1;
        const type = serialized.getUint32(at + 0x10, true);
        const fileOffset = serialized.getUint32(at + 0x1C, true);
        let imageOffset = fileOffset;
        if (size !== 0 && (type === SHT_NOBITS || fileOffset === 0)) {
            imageOffset = align(imageSize, alignment);
            imageSize = imageOffset + size;
        } else if (size !== 0) {
            range(declaredSize, fileOffset, size, `XFF section ${i}`);
            imageSize = Math.max(imageSize, fileOffset + size);
        }
        const nameOffset = serialized.getUint32(sectionNameOffsets + i * 4, true);
        sections.push({
            name: cstring(source, sectionStrings + nameOffset),
            size, type, fileOffset, imageOffset,
        });
    }

    const bytes = new Uint8Array(imageSize);
    bytes.set(source.subarray(0, declaredSize));
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < sections.length; i++)
        view.setUint32(sectionTable + i * SECTION_SIZE + 4, sections[i].imageOffset, true);

    const symbols: number[] = [];
    const unresolvedSymbols: string[] = [];
    for (let i = 0; i < symbolCount; i++) {
        const at = symbolTable + i * SYMBOL_SIZE;
        const value = serialized.getUint32(at + 4, true);
        const info = serialized.getUint8(at + 0x0C);
        const sectionIndex = serialized.getUint16(at + 0x0E, true);
        let address = value;
        if (sectionIndex === SHN_UNDEF) {
            const name = cstring(source, symbolStrings + serialized.getUint32(at, true));
            if (name !== '')
                unresolvedSymbols.push(name);
            // A self-contained offset image cannot bind imports. Keep a null
            // placeholder, just as the dynamic linker does before resolving
            // the module against its resource group.
            address = 0;
        } else if (sectionIndex !== SHN_ABS && sectionIndex < sections.length && (info & 0x0F) < 4) {
            address = (sections[sectionIndex].imageOffset + value) >>> 0;
        }
        symbols.push(address);
        view.setUint32(at + 4, address, true);
        view.setUint32(symbolValues + i * 4, address, true);
    }

    let relocationCount = 0;
    for (let tableIndex = 0; tableIndex < relocationTableCount; tableIndex++) {
        const table = relocationTables + tableIndex * RELOCATION_TABLE_SIZE;
        const tableType = serialized.getUint32(table, true);
        if (tableType !== 4 && tableType !== 9)
            continue;
        const count = serialized.getUint32(table + 4, true);
        const targetSectionIndex = serialized.getUint32(table + 8, true);
        const entries = serialized.getUint32(table + 0x14, true);
        const addends = serialized.getUint32(table + 0x18, true);
        range(declaredSize, entries, count * 8, 'XFF relocation entries');
        range(declaredSize, addends, count * 8, 'XFF relocation addends');
        const section = sections[targetSectionIndex];
        if (section === undefined)
            throw new Error('Legacy XFF relocation targets an invalid section');
        for (let i = 0; i < count; i++) {
            const entry = entries + i * 8;
            const offset = serialized.getUint32(entry, true);
            const packed = serialized.getUint32(entry + 4, true);
            const kind = packed & 0xFF;
            const symbol = symbols[packed >>> 8];
            if (symbol === undefined || offset + 4 > section.size)
                throw new Error('Invalid legacy XFF relocation record');
            const target = section.imageOffset + offset;
            const addend = serialized.getUint32(addends + i * 8, true);
            if (kind === 0) {
                // R_MIPS_NONE
            } else if (kind === 2) {
                view.setUint32(target, (symbol + addend) >>> 0, true);
            } else if (kind === 4) {
                view.setUint32(target, (addend & 0xFC000000) |
                    (((addend & 0x03FFFFFF) + (symbol >>> 2)) & 0x03FFFFFF), true);
            } else if (kind === 5) {
                let low = i + 1;
                while (low < count && (serialized.getUint32(entries + low * 8 + 4, true) & 0xFF) === 5) low++;
                if (low >= count || (serialized.getUint32(entries + low * 8 + 4, true) & 0xFF) !== 6)
                    throw new Error('Legacy XFF HI16 relocation has no following LO16');
                const lowWord = serialized.getUint32(addends + low * 8, true);
                const signedLow = (lowWord << 16) >> 16;
                const combined = (symbol + (addend & 0xFFFF) * 0x10000 + signedLow) >>> 0;
                view.setUint32(target, (addend & 0xFFFF0000) |
                    (((combined + 0x8000) >>> 16) & 0xFFFF), true);
            } else if (kind === 6) {
                view.setUint32(target, (addend & 0xFFFF0000) |
                    (((symbol + addend) >>> 0) & 0xFFFF), true);
            } else {
                throw new Error(`Unsupported legacy XFF relocation type ${kind}`);
            }
            relocationCount++;
        }
        setPointer(view, table + 0x0C, entries);
        setPointer(view, table + 0x10, addends);
    }

    for (const [field, offset] of [
        [0x20, serialized.getUint32(0x50, true)], [0x28, symbolTable],
        [0x2C, symbolStrings], [0x30, sectionTable], [0x34, symbolValues],
        [0x3C, relocationTables], [0x44, sectionNameOffsets],
        [0x48, sectionStrings], [0x18, declaredSize],
    ]) setPointer(view, field, offset);

    const entrySection = sections.slice(1).find((section) =>
        section.size !== 0 && (section.type === 1 || section.type === 0x7FFFF420));
    const entryOffset = entrySection === undefined ? 0 :
        entrySection.imageOffset + serialized.getUint32(0x4C, true);
    return {
        image: ArrayBufferSlice.fromView(bytes), entryOffset, sections, relocationCount,
        unresolvedSymbols,
    };
}
