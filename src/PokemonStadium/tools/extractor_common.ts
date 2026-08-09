export function fragmentOffset(address: number, data: Buffer, allowNull = false): number | null {
    if (address === 0 && allowNull) return null;
    // Model fragments are linked in the game's 0x8FFxxxxx virtual window. The
    // low 20 bits are invariant when the game relocates the fragment at load.
    if (((address & 0xFFF00000) >>> 0) !== 0x8FF00000)
        throw new Error(`unexpected fragment pointer 0x${address.toString(16)}`);
    const offset = address & 0x000FFFFF;
    if (offset >= data.length) throw new Error(`fragment pointer outside payload: 0x${address.toString(16)}`);
    return offset;
}
