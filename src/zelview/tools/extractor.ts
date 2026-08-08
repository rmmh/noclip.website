import { createHash } from 'crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

const inputPath = process.argv[2];
if (inputPath === undefined)
    throw new Error('usage: node extractor.ts <Ocarina of Time USA Rev 2 ROM> [output directory]');

const outputRoot = process.argv[3] ?? './data/ZeldaOcarinaOfTime';
const dmadataOffs = 0x7960;
const codeDMAIndex = 27;
const sceneTableOffs = 0xEA450;
const sceneTableEntrySize = 0x14;
const expectedMD5 = '57a9719ad547c516342e1a15d5c28c3d';

// Canonical scene IDs from OoT's gSceneTable.
const scenes: [string, number][] = [
    ['spot04_scene', 0x55], ['ydan_scene', 0x00], ['ydan_boss_scene', 0x11], ['spot10_scene', 0x5B],
    ['spot05_scene', 0x56], ['Bmori1_scene', 0x03], ['moribossroom_scene', 0x14], ['spot01_scene', 0x52],
    ['kinsuta_scene', 0x50], ['mahouya_scene', 0x4E], ['spot02_scene', 0x53], ['hakasitarelay_scene', 0x48],
    ['hakaana_ouke_scene', 0x41], ['HAKAdan_scene', 0x07], ['HAKAdan_bs_scene', 0x18],
    ['HAKAdanCH_scene', 0x08], ['hakaana_scene', 0x3F], ['hakaana2_scene', 0x40],
    ['syatekijyou_scene', 0x42], ['spot16_scene', 0x60], ['spot17_scene', 0x61], ['spot18_scene', 0x62],
    ['ddan_scene', 0x01], ['ddan_boss_scene', 0x12], ['HIDAN_scene', 0x04], ['FIRE_bs_scene', 0x15],
    ['spot00_scene', 0x51], ['spot20_scene', 0x63], ['spot03_scene', 0x54],
    ['daiyousei_izumi_scene', 0x3B], ['yousei_izumi_tate_scene', 0x3C], ['yousei_izumi_yoko_scene', 0x3D],
    ['kakusiana_scene', 0x3E], ['hiral_demo_scene', 0x47], ['spot15_scene', 0x5F],
    ['hairal_niwa_scene', 0x45], ['hairal_niwa_n_scene', 0x46], ['nakaniwa_scene', 0x4A],
    ['miharigoya_scene', 0x4D], ['bowling_scene', 0x4B], ['takaraya_scene', 0x10],
    ['tokinoma_scene', 0x43], ['kenjyanoma_scene', 0x44], ['spot06_scene', 0x57],
    ['hylia_labo_scene', 0x38], ['turibori_scene', 0x49], ['MIZUsin_scene', 0x05],
    ['MIZUsin_bs_scene', 0x16], ['spot07_scene', 0x58], ['spot08_scene', 0x59],
    ['bdan_scene', 0x02], ['bdan_boss_scene', 0x13], ['ice_doukutu_scene', 0x09],
    ['spot09_scene', 0x5A], ['spot12_scene', 0x5D], ['men_scene', 0x0B], ['gerudoway_scene', 0x0C],
    ['spot13_scene', 0x5E], ['spot11_scene', 0x5C], ['jyasinzou_scene', 0x06],
    ['jyasinboss_scene', 0x17], ['ganontika_scene', 0x0D], ['ganontikasonogo_scene', 0x0F],
    ['ganon_tou_scene', 0x64], ['ganon_scene', 0x0A], ['ganon_sonogo_scene', 0x0E],
    ['ganon_boss_scene', 0x19], ['ganon_demo_scene', 0x4F], ['ganon_final_scene', 0x1A],
];

interface DMAEntry {
    vStart: number;
    vEnd: number;
    pStart: number;
    pEnd: number;
}

interface OutputFile {
    filename: string;
    entry: DMAEntry;
    data: Buffer;
}

function normalizeROM(src: Buffer): Buffer {
    const magic = src.readUInt32BE(0);
    if (magic === 0x80371240)
        return src;
    const dst = Buffer.alloc(src.length);
    if (magic === 0x37804012) {
        for (let i = 0; i < src.length; i += 2) {
            dst[i] = src[i + 1];
            dst[i + 1] = src[i];
        }
    } else if (magic === 0x40123780) {
        for (let i = 0; i < src.length; i += 4) {
            dst[i] = src[i + 3]; dst[i + 1] = src[i + 2];
            dst[i + 2] = src[i + 1]; dst[i + 3] = src[i];
        }
    } else {
        throw new Error('not an N64 ROM');
    }
    return dst;
}

function decompressYaz0(src: Buffer, size: number): Buffer {
    if (src.toString('ascii', 0, 4) !== 'Yaz0')
        throw new Error('invalid Yaz0 stream');
    const dst = Buffer.alloc(size);
    let srcOffs = 0x10, dstOffs = 0, code = 0, bitsLeft = 0;
    while (dstOffs < dst.length) {
        if (bitsLeft === 0) {
            code = src[srcOffs++];
            bitsLeft = 8;
        }
        if (code & 0x80) {
            dst[dstOffs++] = src[srcOffs++];
        } else {
            const a = src[srcOffs++], b = src[srcOffs++];
            let count = a >>> 4;
            if (count === 0)
                count = src[srcOffs++] + 0x12;
            else
                count += 2;
            let copyOffs = dstOffs - (((a & 0x0F) << 8) | b) - 1;
            while (count-- > 0 && dstOffs < dst.length)
                dst[dstOffs++] = dst[copyOffs++];
        }
        code <<= 1;
        bitsLeft--;
    }
    return dst;
}

function readDMATable(rom: Buffer): DMAEntry[] {
    const entries: DMAEntry[] = [];
    for (let offs = dmadataOffs; ; offs += 0x10) {
        const entry = {
            vStart: rom.readUInt32BE(offs + 0x00), vEnd: rom.readUInt32BE(offs + 0x04),
            pStart: rom.readUInt32BE(offs + 0x08), pEnd: rom.readUInt32BE(offs + 0x0C),
        };
        if (entry.vStart === 0 && entry.vEnd === 0)
            return entries;
        entries.push(entry);
    }
}

function loadDMAFile(rom: Buffer, entry: DMAEntry): Buffer {
    const size = entry.vEnd - entry.vStart;
    if (entry.pEnd === 0)
        return Buffer.from(rom.subarray(entry.pStart, entry.pStart + size));
    return decompressYaz0(rom.subarray(entry.pStart, entry.pEnd), size);
}

function findRooms(scene: Buffer): [number, number][] {
    for (let offs = 0; offs + 8 <= scene.length; offs += 8) {
        const command = scene[offs];
        if (command === 0x14)
            break;
        if (command !== 0x04)
            continue;
        const count = scene[offs + 1];
        const tableOffs = scene.readUInt32BE(offs + 4) & 0x00FFFFFF;
        const rooms: [number, number][] = [];
        for (let i = 0; i < count; i++)
            rooms.push([scene.readUInt32BE(tableOffs + i * 8), scene.readUInt32BE(tableOffs + i * 8 + 4)]);
        return rooms;
    }
    throw new Error('scene has no room table');
}

function writeZELVIEW0(path: string, files: OutputFile[]): void {
    const headerSize = 0x10 + files.length * 0x40;
    const size = headerSize + files.reduce((n, file) => n + file.data.length, 0);
    const dst = Buffer.alloc(size);
    dst.write('ZELVIEW0', 0, 'ascii');
    dst.writeUInt32LE(files.length, 0x08);
    dst.writeUInt32LE(0, 0x0C);
    let dataOffs = headerSize;
    files.forEach((file, i) => {
        const offs = 0x10 + i * 0x40;
        dst.write(file.filename, offs, 0x30, 'ascii');
        dst.writeUInt32LE(file.entry.vStart, offs + 0x30);
        dst.writeUInt32LE(file.entry.vEnd, offs + 0x34);
        dst.writeUInt32LE(dataOffs, offs + 0x38);
        dst.writeUInt32LE(dataOffs + file.data.length, offs + 0x3C);
        file.data.copy(dst, dataOffs);
        dataOffs += file.data.length;
    });
    writeFileSync(path, dst);
}

function main(): void {
    const rom = normalizeROM(readFileSync(inputPath));
    const md5 = createHash('md5').update(rom).digest('hex');
    if (md5 !== expectedMD5)
        throw new Error(`unsupported ROM (MD5 ${md5}); expected Ocarina of Time USA Rev 2 ${expectedMD5}`);
    const dma = readDMATable(rom);
    const byVStart = new Map(dma.map((entry) => [entry.vStart, entry]));
    const code = loadDMAFile(rom, dma[codeDMAIndex]);
    mkdirSync(outputRoot, { recursive: true });

    for (const [name, sceneId] of scenes) {
        const tableOffs = sceneTableOffs + sceneId * sceneTableEntrySize;
        const sceneVStart = code.readUInt32BE(tableOffs + 0x00);
        const sceneVEnd = code.readUInt32BE(tableOffs + 0x04);
        const sceneEntry = byVStart.get(sceneVStart);
        if (sceneEntry === undefined || sceneEntry.vEnd !== sceneVEnd)
            throw new Error(`${name}: missing scene at 0x${sceneVStart.toString(16)}`);
        const sceneData = loadDMAFile(rom, sceneEntry);
        const files: OutputFile[] = [{ filename: `${name}.zscene`, entry: sceneEntry, data: sceneData }];
        findRooms(sceneData).forEach(([vStart, vEnd], i) => {
            const entry = byVStart.get(vStart);
            if (entry === undefined || entry.vEnd !== vEnd)
                throw new Error(`${name}: missing room ${i} at 0x${vStart.toString(16)}`);
            files.push({ filename: `${name}_room_${i}.zmap`, entry, data: loadDMAFile(rom, entry) });
        });
        writeZELVIEW0(join(outputRoot, `${name}.zelview0`), files);
    }
    console.log(`Extracted ${scenes.length} Ocarina of Time scenes from ${basename(inputPath)}`);
}

main();
