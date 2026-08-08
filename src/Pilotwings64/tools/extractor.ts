import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const pathBaseIn = './data/Pilotwings64_Raw';
const pathBaseOut = './data/Pilotwings64';

function readFourCC(rom: Buffer, offs: number): string {
    return rom.toString('ascii', offs, offs + 4);
}

function countForms(rom: Buffer, start: number): { count: number, end: number } {
    let offs = start;
    let count = 0;
    while (offs + 12 <= rom.length && readFourCC(rom, offs) === 'FORM') {
        const size = rom.readUInt32BE(offs + 4);
        if (size < 4 || offs + 8 + size > rom.length)
            break;
        offs += 8 + size;
        count++;
    }
    return { count, end: offs };
}

function main(): void {
    const rom = readFileSync(`${pathBaseIn}/rom.z64`);
    let best = { count: 0, start: 0, end: 0 };

    for (let start = rom.indexOf('FORM'); start >= 0; start = rom.indexOf('FORM', start + 4)) {
        const chain = countForms(rom, start);
        if (chain.count > best.count)
            best = { ...chain, start };
    }

    if (best.count === 0)
        throw new Error('could not find Pilotwings FORM filesystem');

    mkdirSync(pathBaseOut, { recursive: true });
    writeFileSync(`${pathBaseOut}/fs.bin`, rom.subarray(best.start, best.end));
    console.log(`Extracted ${best.count} files from 0x${best.start.toString(16)}-0x${best.end.toString(16)}`);
}

main();
