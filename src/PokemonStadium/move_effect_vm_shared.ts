export const fragmentVirtualBase = 0x84300000;
export const relocatedFragmentBase = 0x0F000000;
export const particleAddress = 0x10000000;
export const stackAddress = 0x11000000;
export const returnSentinel = 0xFFFFFFFF;

export const primaryColorIndices = [0x0C, 0x19, 0x23, 0x36, 0x2F, 0x3B];
export const secondaryColorIndices = [0x17, 0x19, 0x25, 0x23, 0x35, 0x14];
export const randomColorIndices = [0x0A, 0x19, 0x36, 0x24, 0x16];

export function fragment34ConstantByte(address: number): number | undefined {
    if (address >= 0x8140E538 && address < 0x8140E538 + primaryColorIndices.length)
        return primaryColorIndices[address - 0x8140E538];
    if (address >= 0x8140E540 && address < 0x8140E540 + secondaryColorIndices.length)
        return secondaryColorIndices[address - 0x8140E540];
    if (address >= 0x8140E548 && address < 0x8140E548 + randomColorIndices.length)
        return randomColorIndices[address - 0x8140E548];
    return undefined;
}

export function sign16(value: number): number { return value << 16 >> 16; }

const floatBuffer = new ArrayBuffer(4);
const floatView = new DataView(floatBuffer);

export function bitsToFloat(value: number): number {
    floatView.setUint32(0, value >>> 0);
    return floatView.getFloat32(0);
}

export function floatToBits(value: number): number {
    floatView.setFloat32(0, value);
    return floatView.getUint32(0);
}
