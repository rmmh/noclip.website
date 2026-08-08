import { mkdirSync, readFileSync, writeFileSync } from 'fs';

const pathBaseIn = './data/BeetleAdventureRacing_Raw';
const pathBaseOut = './data/BeetleAdventureRacing';

function readFourCC(rom: Buffer, offs: number): string {
    return rom.toString('ascii', offs, offs + 4);
}

function align(n: number, alignment: number): number {
    return (n + alignment - 1) & ~(alignment - 1);
}

function main(): void {
    const rom = readFileSync(`${pathBaseIn}/rom.z64`);
    let tableStart = -1;

    for (let offs = rom.indexOf('FORM'); offs >= 0; offs = rom.indexOf('FORM', offs + 4)) {
        if (readFourCC(rom, offs + 8) === 'UVFT') {
            tableStart = offs;
            break;
        }
    }

    if (tableStart < 0)
        throw new Error('could not find Beetle Adventure Racing UVFT filesystem table');

    const tableEnd = tableStart + 8 + rom.readUInt32BE(tableStart + 4);
    const filesStart = align(tableEnd, 0x10);
    let tableOffs = tableStart + 12;
    let filesystemEnd = filesStart;
    let fileCount = 0;
    while (tableOffs < tableEnd) {
        const entryBytes = rom.readUInt32BE(tableOffs + 4);
        tableOffs += 8;
        for (let i = 0; i < entryBytes; i += 4) {
            const fileOffs = rom.readInt32BE(tableOffs + i);
            if (fileOffs < 0)
                continue;

            const absoluteOffs = filesStart + fileOffs;
            if (absoluteOffs >= rom.length)
                throw new Error(`filesystem entry points outside ROM: 0x${absoluteOffs.toString(16)}`);

            let fileEnd = absoluteOffs;
            if (readFourCC(rom, absoluteOffs) === 'FORM') {
                fileEnd += 8 + rom.readUInt32BE(absoluteOffs + 4);
                fileCount++;
            }
            filesystemEnd = Math.max(filesystemEnd, fileEnd);
        }
        tableOffs += entryBytes;
    }

    if (tableOffs !== tableEnd || fileCount === 0)
        throw new Error('invalid UVFT filesystem table');

    mkdirSync(pathBaseOut, { recursive: true });
    writeFileSync(`${pathBaseOut}/filesystem.bin`, rom.subarray(tableStart, filesystemEnd));
    console.log(`Extracted table and ${fileCount} files from 0x${tableStart.toString(16)}-0x${filesystemEnd.toString(16)}`);
}

main();
