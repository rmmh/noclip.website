import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inflateRawSync, zstdCompressSync } from 'node:zlib';
import 'tsx/esm';
import { archiveVersion } from '../archive.ts';
import { AttachmentSlot, Fast3DOpcode, ModelNodeType, PropFlag, SetupType } from '../constants.ts';
import type { EnvironmentArchive, LevelArchive, ModelArchive, ModelBSPPathArchive, ModelBSPPlaneArchive, ModelDisplayListArchive, ModelScreenArchive, ModelShadowArchive, PortalArchive, PropArchive, RoomArchive, TextureArchive } from '../archive.ts';

// Keep noclip's browser-oriented `.js` source specifiers behind tsx's resolver.
// This lets modern Node run this file directly while keeping Node-only imports
// out of the browser scene module graph.
const { default: ArrayBufferSlice } = await import('../../ArrayBufferSlice.ts');
const BYML = await import('../../byml.ts');
const { decodeGoldenEyeTexture } = await import('./texture.ts');
const { modelMetadata } = await import('./model-metadata.ts');
const { characterMetadata, headMetadata } = await import('./character-metadata.ts');

// Big-endian u16 byte lengths from the NTSC-U g_Textures initializer
// (assets/images.def). image_entries_load turns these into cumulative offsets.
const imageSizesBE = Buffer.from('B1QBagl0A4sBUwJeA74AGgAaA38DkQDgA6QEowR3BHEErAPaABoAGgYZATUF9QNfA1AGDADFAKYAtQPdA/wDCAMGBkoFzAagBsYD6wETAicCGQIrAiIFPQVcA+8BmgRUBr4CfAXmAzgE0AWgBJIDGAEOAPEBGQKmAaAAIgEUAJwDpQN4A0QA9wObAa0B5ALVAMYAxwKzAaIBkAXhAq8A3gH0BeQBuQXzAicC1wOuAvkMKgv9DDELGAvGDGgMpQvUC30L2AxBC58L5gzuDQYLoQsnDRgMygpaCHYIqgjPB5QKegySC4oKUwvwDQwMzAn4DMENOw1tC/AJgAuRDKEKggx6DUsNhQx2C6kNWg1QDDUKjQ0mCyUImQR3BIUEVghACEoIawfCAhICSwFJASUDEAE3AScBOwLBA7wFjgFGATsCMwLhAxwDCwM/AvUDPgMOA1MEdwL5AlsAugKmA6oCPAfeAnEC8wMUASgB+QKzAgcCWwVJBEsDfwYgBFMFbAWXBRYCiALIBZcEfQKfAqMBSgS6A/oFLwRgBWEE9wQJBkMLKww+BXgAzwKQBNYA4AJuAU4B4AEZA9gECQPyBAkEQgQ9A/YCswN/AmkCKQODBdoDQQEuBVQDnQSWBOkDxwPfBAACRQH2AV8EeAINAuIAxwC0AJgAxwMpAqECzQQIA+sBzwM9AocDJgOAArECxAIuBYQBqABPBVgC1wWCArYFFgTgB5kHgAgMB6cHhAazApoDiQLuAx8DIgV4Ax4EKATBBHkE+QSLA98FRgUwBSsD7wRAA6IDDwMDAwMDdAU1An8AyAI9Aq8FYAOFA7UFRwMvA4gCfAJ8AkUCRQJGAqYBQQIYBFsF6wYbBi0GHwZBBlMF9QNEA4YDmQNgAWEBGgEzASoDSAUnA5oD7gPYBFsA6AEiBA0D4QDBAQ8DAgIVANUDMgHIAKgDigLABEoD2wNdA00FNgPABMgDzQIUAvQDtgPeAm4CbgVfBYoDNwP/A7UDtQMyA/wDxARGA/oCYQU1BW0ETwl9CQIJLQkUCYEI/gj1CHgCIQRwBSYE5gQlA1sENQQ5AzwDDAL/ArMFKQNNAg0DnQLxAbMCDgFrAgcBjwHPAb8G1gPcBuACIwHjAVgBgQRTBV4FuwUlBy0EvgLzBDwD5gYrAx0DAAZPBfcGZQPIA8sDZga2ByIIpwjMA/ADOwJEAgAB9wRzA8QD2wHgAe0FLQR/AlAChgC0AKMB5gGuAoUCIwH6B6IHngFAAnYCkAJkBIQDxgNDAzsDKQPNAUEFIARzBMADgQOwA/IEXgSQA6kDmwNiAqgFuQC7ALoAtwEJAOEEngRzA1wDNwJ+AkgCOwFSArMBiAJ3AgUBpACeAywErwEKATgBPwTUAUcChwCdAu0CXwEKAuADcwGqAu0BSwSEAuoARQHkA8QEMAMlApYElwM8Aq8A+QQWA0MF7AdkB24HKwQsA8gECwbnBo8GAgYCBfUGxgX5BqsHaAZsBi0GNgYBBqgGnwZGAXoH7Qc2B28IAgfsB3AHAQfuA2MEvgSRAfQAyQX+BfcGDAYFBA8EAARiBRwE3QUxBKwEagWTA3sEugWOAbEFYQZTB4AGUQHhBXoFJQW1AWYBRQaeCDkFfAfaAr4CaAKbAoYCbgJRA54BFAJjBZgEaAR6ASUBvgELAUgBQAFIBbID6AJtA8EDzQBVAmQDZgG/BzgDLAVTA4wBLQLWAb0EowGZAr0CZAH+BOwCbAJLA0UDeQCkAKsAVQQBA0IE2QS1AMQA4gXnA/YD5QO9BDwDSQQ5A3kDYgNrAxgCowCBAnoE6gWjBYAE/gE6Ad4C5gKiAxMDPwIfARYAogFNBE0CUQH8AhEBxAGEAh8BVwM8AIoCDQIIA3QClgHyAV8EvgMVBNoCTQYMAMABbgNSAP0B8wJRAhsAsQIoAhgDUwQmAcUDmQPxAckBmAHHBTcFGwSjBe4F2AWFBUIFggRJBJsFbQW+BdsEBAT+BYwFYwWyBXsEiwSuBRQFnAVoBboFkQIIAf4FBQOfALIApwBnBV8B/gMhATEBUwSCBgwCWQODAHgEzAVDBbwDcQXCBOIGRQU7BEgB+AEoAWwDxwI9BiwGAgXfBmgGeAXtBkACcAJMAmQA4QCYAcMCnwGfAdADDwPbAUUCmQQgAlgCngM1AckEeQHfAtkENgJjBgMFbwBEAlEBhAKrA3YEVQU2BOgFWQV5Bp4HWgarA70DFgTUAk4HdQeqBosGjQV6BXEC+gRuA44EowC3BfwDDwPFAcwB+QGFAt4CjwRSAxsG/AcKAhEC2AG/Ai0BkwToASYA/wMcAXsBYABDAZAALwFOAToALwA5AFEAKQBLACsA3QcAAkgBTwFsA/gCsAG/A7AD6QPQA3IF0gcRBnIEygPqAicDvgNUA1YDtQQdArkBrQUTBMQEbwTdBlsDlwLvAxYDFgCYAagCdgeZApwDkAO6CKYDPgYMBlACNwNcAxMB3gG9AmkBUAQ2AWYBjQIBBCAC1gLaAy8CuQKdAfoCfwDxBecGcQUrCHgHmQXkBggFaAXBBeUHdAKHAocHYAhKCG0IaQg+CDEITgggAoUC8QTLCH8IrQh/CH8Iogh/CRoCWQZ2BnYASgNwAwcDEQUaAZoAEQEpAUIBkQGAATwBYgEmAXUDXgIyBQoEDAPJBNAE7QJnAzoA8ASRAo0BsgYSBx4BmQatAfMDiQNnAv8DeQSOBR8FRQMKA7MEdgIqAJYDMQRPAzEDQwCtBdIEiAR3BNMGGgSPBPsFOwagAhIC5wKlAkQBMAFcA1wGdgLNB24HIweyBhMCKAXSAgcFngGYBUwFDgHjBSQD1gKSAW0DxQW7BToFowcaBAoG4QcjBH4CgAODAuQBQADmBeoEyAUPAOQASAWsAhsDXwIGAWsEawU/A+oD6wUbBIoEyARWA4YE8AVWBTMD6gToBU4FGASfBUoFNwU1A+YEsAUtBTUEbATaBAUFAQWFAroCoAMcAZwA2AcoBK0DJQTsCAEH4wZXBDIJqgN/BN4FqwYMApoBPgHpA7sEPgQlArAA1QFPASkDUAM8A1QBkQTKAyMDhwecBwYC0AL6BJgEnwMHBUkE5QPuBAcF4wVBBTMEOQXwBbEDdAAlAqQCQAIPA2kCJwEhAmkB2QJKAhsEdgaxBWYFqAU/AF4C6gO+AVUAxgNCA9YDKQfOBdQGIQfzB24HrAHjAowC0gO4BUQEygUmBXUEuwV1BdIFnwE9BuQGfQLpA3MBYgERAMMCHgQ6BU0CjQPDA8EDrAWeA0kD2ARTBB8GrwOdAwAD4gOLAyoEDgMzAsUCZQNsBT4EsAGYBOkCnALjAtkCdgLjA6sCSQDaA3cFRwPnAwMB8gEoAbIBBASkAz4FTARhAvkFTQHhAicB9QM+AtYBoQDLBPABkwNwA64EGAG3ApgIFAgKCBQICgYMBD0GAQYMBZwF7wXuBgwGDAShBO4F4AYMBgwGDAgUCAoICggKBfkGDAfmB+wH+wgKCAwICggKCAUF6QXVBekEUgYMBgwIFAgUCAoICAgKCAoICggKBJoF6wU3BgkF7QUGA4ME9QgUCBQICggKCAoICggKCAoIFAgUCAoICggKCAoICggKAxUCgwKGBIYF9gYMBgkExwM+BCcB2gYTBMIE4wRTBHsCfAMnAuEDNwJOAfADMwDSBLsAKAAmAzoCeQYCAxMDEwVFA/8EYgP9AY8CTgOsBY8FXgQXBMYFhQRmCU8I8AkBCS0JQAkJCUAI8QHEAXMBVQMRApICKwH9Ac0CAwKCAk4B3wIUBBcB9AXhAF0FVgFhAVkEvwKDAy4BNAJOARYA8AESA9MD0wPnBEoBGwEsAXUCfgHIAuEB/wL4ApsCeAKfAlECjgJuAtIDkQQyATsCegJvBQUE3gSyAzsC1wG2AfIGowajAn8CWwGkBYICHQUdBPgEhwNoA3wHigBJAEsAMwO+AL4BqAbOBnQHBgbEBt4HAAa8BuUGawc7A+YEBAOdAuoFdAEOAhABXwMRA68E9wKKAjQCkgKFBUkB9gAMAWgBkAJQBXoELAT/AyMB3wUDAaUC7ASFBygCIwPLAVoA5wF2AbQCwwKoAjoCRgJAAnwC6gSxBHQEhQfWCIEEKgW8BywIkQdcCNwJSgkkCXACTgmkAzcGCAYMCecJ3AnCAfgCUQIyAfsFwAQHCekIpgloBcUEGgOGA94CcgOVA1AC7AMkAsYHHgcPA1kDyQOgA2sAtwT7BT8E0QcNAtwDpgGbA8wAKAA1AjcDpQOOAqUCjwAMAdsHWwJ4AAwD1wFVA/sDrQWcATEDuQT0AU8DtQSWAW4DywTnAbIIYAh6BvwBTwL6Av8BNALUBP4FNAODA2oC8QNsAToANwOZAukEHwMsBb4CzQMNBc4HKAR8BfIAQAa8CaoH+gP+BM4CvAXQBW0HkQlRB40CTgMNCTYE0QVOAXYFoQWGAAwEYgX3BzQHOgbHB5kEZQZeBJsGgAmMCSAJHQm+Bm8GEQWzAUcGmgU1BAoDHALQAr8JmAHBArQDHAOIA+4I2whZA2oJVwmfCdAGlgG+AqEFWAG7ArcCgwJQAsEE4QNsAwcC6gLBCUMIwwkHAAwJ0gmzCZAD/gQKBEcEGAgzB+kDQQFxBgcFjQO3BAAEWgcSAiYEFQU1B3QHqAdtAnwCqQELA0IB5QH7BcgDmwQWBFIEKAKbAdIGWglkCLwI6AnqCasJtQOMBVkGZwV6BIABoAD2AxcDfgYaBLUBOQFCAZEDAQHCA2cD3QOGAz4DCgLoA0ADaAPVA9sE1wSYBJ0C6gN0BowHLgjiCCAIoQg6AfYB1AL0AT4BcwZ4ApkFowoMCeMJ6QlACbIJZgnhCSkJSAnoCc0JpAlhCWUJCQOTAVcCiwMSCdkJBQkoAncCfAEWAccBBAKIBh0BhQhZCJ8H6AmmCK0IvwkpCVkJOwjwCLgJMwTbCUEGwwhEAyoGCgOmARACtgclBP4ADAjPCUoJqAeMCd4BFAV/AcIH1AflCeMHvQSoALoF0QlsCHoIAARwAhECCgMqA+cCYwoMBgwF8AZqAyIDfwN/AxQDMwGcAjIBUQF2B6kHmgkyCM0IzgEEAvMFtAM+BQ4F+gRkAAwFdwWDCKQDUgLXA1sDwwR3BH8CkQj1CQgJ0wjJAqAIOAf1AxUFFgRrAwUE3gRrAyAGlQluCZ0JlgOOAkgCzAB5BhwEjgVaBSMGUgVDBNcFYwPGBEYCagVhAlkHVwcSBCsBcgNcA/kFlAmKCQsJxQjjCUkJDwoMCWAJXAGzBCUHbAd1Aa8BdgLAA5QDBgVdBT4BeQF9AbcBzAGBAPACIAmYCbcJbQi8CLoIhAkkCBICdgGcAP4CsQJpB2gAuQDkAUEDDwFAA5gBgwEvAVgBrgHVAMQDmAK/B2EBHgO7BlQFtwZvBsMEAAMIA4IFpAKxBEEB9AGnCQAH9AElAZoFWgIwAw4JRAKBAlUEUQO+AbsGygerA8cJcgAMAZYCewGqCYEJawkDAkUBLwSLAvoEJgYLBLsDigRfBJIDDwQJA5YJrgeoCLIC3gOoBrUGKgAHAAgE3QEjA68A0QSFAP4EJQDaAxMAeACqADIDywEABKwBEgVVASAFswEyBe0BQgWrATcFgAE1BSYBLQj5CMYILgjFAZwI+wdhBssG8gbTB4sHPAeSB3UEfQYkBgwGDAYMBgoLxwUUBIcJ/QlfB8UIpwdZBpAGZAazCA4Hnwd1B38GuQZGBkkGVAWABQsFBQUrCDIH5wfTB4cCGgLoA44AlQKDAgEAjgP5A08GWAR0AhwFKQRQBFcB5wThAZ4ChAObA2UFZQYBBkwGOgZFA40DmQRcA04EDwQrASIF5QXTBZ0FawWHBYoBegX3BfYFjQXWBeoFJgHrAcsB7AQ8BEIEOwQ7BrYBsAGvAbEBwgMbAzQDMANFAccAiAAyAFQGSQaxBrUEaAC6AYsAjwLfAuEEAwGuAuAJ4QnzBbUExARYB30L0gnPBoMDcAyLBdsF5AWUBZsEEgHeAtsDKwNcArMIOgWeBuoBqgNQBJsHAAfPB8sG1QT0BK0CEANCAKcBwANTBAwDugQADj4EIgQAApUF1QIjAlgCQgG6AdMA/AHuAboB6wI+BWMBuwGNAoAAnQMUA8cFYQPjBN8ELAYEAPEDNwRKBP8BlwL/AqwDBgPkAokCmgSvBD8D8AP0BB8DxgQdAtACkwPmAg4DdwObBRwCsgUEBa0C4wP/AacCwgDtAtIFBAQ9BBkCtQYMAp0E7gTxAjYDVAKOA/oE0gWEA/4EqwR0BHAEQATMBM8EpwGKAaYBSgODAfwBhQPRBLQFdQQNB/MGLQMMBBYERAGqAiEGSAQgA/0EAwQIBFUD/AQIAxMDLQJ7ArUFGgPkApMDjASTAxYC2gK2AwQCjgN/BgwGDAO+BgwCVATJBgwGPwXxBv8GOgLqBB8DPQOlAy4D+gNhBxoHlAaiAiED+AMcAfEAwgIKBckAqwE2A1YDEQXNAeEDUwMHAXoFuQM8A3QD9QRsAwIEpgOxAqkCIwClBJIAxAG8BDkC/AMIAFUCDwEMAXEDrgcUALYA4QITAnAFZwTzAVoBogJSAogDWwUUAjYIOAOsA1gC9AG+AXIDTQVaBZMC4gJPAtsE7wTQA10DkQAPBVIB2AUNBagE1wOKAuMEagQvA5EJGAisCSQJiwm7CZsFvQQGBCkEaQRXA3wFNQdpB7AHlwb0Bd8HRwgvCYoJGgb1A9QEUgTnCAcHqQafCM0G+gMGBEsEEgfrCSUJWQmhCVAHfgouCMsJHgkPCOgHqQngCLsJEwa1CD0IXQhABioGdwQHCLcI7Qk0BzAHAQeFCGIHmQhuBxsF8wczB1gKJwqkB2EG9AYyBosJfQouCZgJrgmlCK0JmAgcCO4H3QiECXkIZAkfCLYHWAgzCm4INwjmBSkFHgWEBaYFfwX9BMoGCwVmBawEhQbkBQoFaAYWBZ8FlAS+BUwFEwc9BuIG9AbeBm8GxAWbB1oDowZ6BvICigVCADUEuAUjBScF+gYUBQkFmAW7BOcE7QQTBDIE2gUUBKsEzwVSBLwFNgYPBUMFTgS9BMME0wSJBpcGQgVnBRwFPQVtBV4EWwWlBasFVAUWBX8EvACgAPgDlwC8BDUKDAc1AtYI3gJ3A7MDtALBAsQJdgnICjkIbwOABUQFEwUCBOQBowIBBT0=', 'base64');
const imageOffsets: number[] = [0];
for (let i = 0; i < imageSizesBE.length; i += 2)
    imageOffsets.push(imageOffsets[imageOffsets.length - 1] + imageSizesBE.readUInt16BE(i));
const imagesSegmentRomStart = 0x8F7DF0;

const romPath = process.argv[2];
if (romPath === undefined)
    throw new Error('usage: tsx src/GoldenEye007/tools/extractor.ts <GoldenEye 007 (USA).z64> [output directory]');

const outputRoot = process.argv[3] ?? './data/GoldenEye007';
const rom = readFileSync(romPath);
const expectedSHA1 = 'abe01e4aeb033b6c0836819f549c791b26cfde83';
const actualSHA1 = createHash('sha1').update(rom).digest('hex');
if (actualSHA1 !== expectedSHA1)
    throw new Error(`unsupported ROM: expected GoldenEye 007 (USA) SHA-1 ${expectedSHA1}, got ${actualSHA1}`);

interface RomFile {
    offset: number;
    size: number;
    compressed?: boolean;
}

interface LevelSource {
    id: string;
    name: string;
    code: string;
    scale: number;
    visibility: number;
    bg: RomFile;
    stan: RomFile;
    setup?: RomFile;
    environmentID?: number;
}

// NTSC-U levelinfotable and ROM file records. These are the exact inputs used by
// load_bg_file: the BG stream stays packed room-by-room, while stan/setup files
// use Rare's two-byte wrapper followed by a raw DEFLATE stream.
const levelSources: LevelSource[] = [
    { id: 'bunker1', name: 'Bunker I', code: 'sev', scale: 0.53931433, visibility: 1.0, bg: { offset: 4425312, size: 69104 }, stan: { offset: 8897520, size: 15824, compressed: true }, setup: { offset: 9261456, size: 6704, compressed: true } },
    { id: 'silo', name: 'Silo', code: 'silo', scale: 0.47256002, visibility: 1.0, bg: { offset: 4494416, size: 331584 }, stan: { offset: 8971312, size: 37024, compressed: true }, setup: { offset: 9301952, size: 10832, compressed: true } },
    { id: 'statue', name: 'Statue', code: 'stat', scale: 0.107202865, visibility: 1.0, bg: { offset: 4826000, size: 139472 }, stan: { offset: 9008336, size: 20160, compressed: true }, setup: { offset: 9312784, size: 10192, compressed: true } },
    { id: 'control', name: 'Control', code: 'arec', scale: 0.49886572, visibility: 1.0, bg: { offset: 4965472, size: 189312 }, stan: { offset: 8568400, size: 33616, compressed: true }, setup: { offset: 9149200, size: 15104, compressed: true } },
    { id: 'archives', name: 'Archives', code: 'arch', scale: 0.50678575, visibility: 1.0, bg: { offset: 5154784, size: 154352 }, stan: { offset: 8544608, size: 23792, compressed: true }, setup: { offset: 9089552, size: 17936, compressed: true } },
    { id: 'train', name: 'Train', code: 'tra', scale: 0.15019713, visibility: 1.0, bg: { offset: 5309136, size: 132464 }, stan: { offset: 9028496, size: 9168, compressed: true }, setup: { offset: 9322976, size: 12848, compressed: true } },
    { id: 'frigate', name: 'Frigate', code: 'dest', scale: 0.44757429, visibility: 1.0, bg: { offset: 5441600, size: 186816 }, stan: { offset: 8790736, size: 26864, compressed: true }, setup: { offset: 9208624, size: 9040, compressed: true } },
    { id: 'bunker2', name: 'Bunker II', code: 'sevb', scale: 0.53931433, visibility: 1.0, bg: { offset: 5628416, size: 109984 }, stan: { offset: 8913344, size: 20288, compressed: true }, setup: { offset: 9251632, size: 9824, compressed: true } },
    { id: 'aztec', name: 'Aztec', code: 'azt', scale: 0.35300568, visibility: 1.0, bg: { offset: 5738400, size: 137808 }, stan: { offset: 8645264, size: 21888, compressed: true }, setup: { offset: 9122736, size: 10496, compressed: true } },
    { id: 'streets', name: 'Streets', code: 'pete', scale: 0.34187999, visibility: 1.0, bg: { offset: 5876208, size: 105520 }, stan: { offset: 8865040, size: 18064, compressed: true }, setup: { offset: 9233232, size: 12160, compressed: true } },
    { id: 'depot', name: 'Depot', code: 'depo', scale: 0.21847887, visibility: 1.0, bg: { offset: 5981728, size: 182640 }, stan: { offset: 8762256, size: 28480, compressed: true }, setup: { offset: 9196448, size: 12176, compressed: true } },
    { id: 'complex', name: 'Complex', code: 'ref', scale: 0.94285715, visibility: 1.0, bg: { offset: 6164368, size: 38416 }, stan: { offset: 8883104, size: 7632, compressed: true } },
    { id: 'egypt', name: 'Egyptian', code: 'cryp', scale: 0.25608, visibility: 1.0, bg: { offset: 6202784, size: 87728 }, stan: { offset: 8707904, size: 12400, compressed: true }, setup: { offset: 9171520, size: 7824, compressed: true } },
    { id: 'dam', name: 'Dam', code: 'dam', scale: 0.23363999, visibility: 0.2, bg: { offset: 6290512, size: 197024 }, stan: { offset: 8720304, size: 41952, compressed: true }, setup: { offset: 9179344, size: 17104, compressed: true } },
    { id: 'facility', name: 'Facility', code: 'ark', scale: 1.20648, visibility: 1.0, bg: { offset: 6487536, size: 200576 }, stan: { offset: 8602016, size: 36800, compressed: true }, setup: { offset: 9107488, size: 15248, compressed: true } },
    { id: 'runway', name: 'Runway', code: 'run', scale: 0.089571431, visibility: 1.0, bg: { offset: 6688112, size: 41936 }, stan: { offset: 8890736, size: 6784, compressed: true }, setup: { offset: 9245392, size: 6240, compressed: true } },
    { id: 'surface1', name: 'Surface I', code: 'sevx', scale: 0.45445713, visibility: 0.2, bg: { offset: 6730048, size: 116176 }, stan: { offset: 8933632, size: 37680, compressed: true }, setup: { offset: 9268160, size: 17168, compressed: true } },
    { id: 'surface2', name: 'Surface II', code: 'sevx', scale: 0.45445713, visibility: 0.2, bg: { offset: 6730048, size: 116176 }, stan: { offset: 8933632, size: 37680, compressed: true }, setup: { offset: 9285328, size: 16624, compressed: true } },
    { id: 'jungle', name: 'Jungle', code: 'jun', scale: 0.094662853, visibility: 1.0, bg: { offset: 6846224, size: 86352 }, stan: { offset: 8826880, size: 29008, compressed: true }, setup: { offset: 9217664, size: 14080, compressed: true } },
    { id: 'temple', name: 'Temple', code: 'dish', scale: 0.47142857, visibility: 1.0, bg: { offset: 6932576, size: 18544 }, stan: { offset: 8817600, size: 2832, compressed: true } },
    { id: 'caverns', name: 'Caverns', code: 'cave', scale: 0.26824287, visibility: 1.0, bg: { offset: 6951120, size: 148720 }, stan: { offset: 8677184, size: 20208, compressed: true }, setup: { offset: 9133232, size: 15968, compressed: true } },
    { id: 'citadel', name: 'Citadel', code: 'cat', scale: 0.76852286, visibility: 1.0, bg: { offset: 7099840, size: 21808 }, stan: { offset: 8667152, size: 10032, compressed: true } },
    { id: 'cradle', name: 'Cradle', code: 'crad', scale: 0.23571429, visibility: 1.0, bg: { offset: 7121648, size: 66384 }, stan: { offset: 8697392, size: 10512, compressed: true }, setup: { offset: 9164304, size: 7216, compressed: true } },
    { id: 'basement', name: 'Basement / Stack / Library', code: 'ame', scale: 0.65999997, visibility: 1.0, bg: { offset: 7188032, size: 40800 }, stan: { offset: 8538160, size: 6448, compressed: true } },
    { id: 'caves', name: 'Caves', code: 'oat', scale: 0.14142857, visibility: 1.0, bg: { offset: 7228832, size: 28240 }, stan: { offset: 8858640, size: 6400, compressed: true } },
    { id: 'cuba', name: 'Cuba', code: 'len', scale: 0.094662853, visibility: 1.0, bg: { offset: 7257072, size: 4000 }, stan: { offset: 8855888, size: 2752, compressed: true }, setup: { offset: 9231744, size: 1488, compressed: true } },
];

// Retail multiplayer stage roster from multi_stage_setups. These setup files
// are separate ROM resources even when the BG/STAN geometry is shared with a
// mission. The three ame variants deliberately share one background but have
// distinct Library, Basement and Stack object/spawn layouts. Use the four-player
// environment entry, which is the least restrictive complete-map presentation.
const multiplayerDefinitions: { id: string; name: string; source: string; setup: RomFile; environmentID: number }[] = [
    { id: 'mp-temple', name: 'Temple', source: 'temple', setup: { offset: 0x8A7EF0, size: 0x3F0, compressed: true }, environmentID: 38 + 400 },
    { id: 'mp-complex', name: 'Complex', source: 'complex', setup: { offset: 0x8A8C70, size: 0x410, compressed: true }, environmentID: 31 + 400 },
    { id: 'mp-caves', name: 'Caves', source: 'caves', setup: { offset: 0x8A8920, size: 0x350, compressed: true }, environmentID: 51 + 400 },
    { id: 'mp-library', name: 'Library', source: 'basement', setup: { offset: 0x89E9E0, size: 0x720, compressed: true }, environmentID: 50 + 400 },
    { id: 'mp-basement', name: 'Basement', source: 'basement', setup: { offset: 0x8A82E0, size: 0x640, compressed: true }, environmentID: 46 + 400 },
    { id: 'mp-stack', name: 'Stack', source: 'basement', setup: { offset: 0x8A3BE0, size: 0x6F0, compressed: true }, environmentID: 47 + 400 },
    { id: 'mp-facility', name: 'Facility', source: 'facility', setup: { offset: 0x8A1EA0, size: 0x1D40, compressed: true }, environmentID: 34 + 400 },
    { id: 'mp-bunker', name: 'Bunker', source: 'bunker2', setup: { offset: 0x8A9080, size: 0x1310, compressed: true }, environmentID: 27 + 400 },
    { id: 'mp-archives', name: 'Archives', source: 'archives', setup: { offset: 0x89F100, size: 0x2DA0, compressed: true }, environmentID: 24 + 400 },
    { id: 'mp-caverns', name: 'Caverns', source: 'caverns', setup: { offset: 0x8A42D0, size: 0x2560, compressed: true }, environmentID: 39 + 400 },
    { id: 'mp-egyptian', name: 'Egyptian', source: 'egypt', setup: { offset: 0x8A7190, size: 0xD60, compressed: true }, environmentID: 32 + 400 },
];
const sourceByID = new Map(levelSources.map((level) => [level.id, level]));
const multiplayerLevels: LevelSource[] = multiplayerDefinitions.map(({ source, ...variant }) => {
    const base = sourceByID.get(source);
    if (base === undefined)
        throw new Error(`missing multiplayer BG source ${source}`);
    return { ...base, ...variant };
});
const singlePlayerIDs = ['dam', 'facility', 'runway', 'surface1', 'bunker1', 'silo', 'frigate', 'surface2', 'bunker2', 'statue', 'archives', 'streets', 'depot', 'train', 'jungle', 'control', 'caverns', 'cradle', 'aztec', 'egypt'];
const bonusIDs = ['citadel', 'cuba'];
const sourcesFor = (ids: string[]): LevelSource[] => ids.map((id) => {
    const level = sourceByID.get(id);
    if (level === undefined)
        throw new Error(`missing level source ${id}`);
    return level;
});
const levels: LevelSource[] = [
    ...multiplayerLevels,
    ...sourcesFor(singlePlayerIDs),
    ...sourcesFor(bonusIDs),
];

function extractFile(file: RomFile): Buffer {
    const src = rom.subarray(file.offset, file.offset + file.size);
    if (!file.compressed)
        return Buffer.from(src);
    try {
        return inflateRawSync(src.subarray(2));
    } catch (e) {
        throw new Error(`failed to inflate ROM file at 0x${file.offset.toString(16)} (${file.size} bytes): ${e}`);
    }
}

const levelIDs = new Map<string, number>([
    ['bunker1', 9], ['silo', 20], ['statue', 22], ['control', 23],
    ['archives', 24], ['train', 25], ['frigate', 26], ['bunker2', 27],
    ['aztec', 28], ['streets', 29], ['depot', 30], ['complex', 31],
    ['egypt', 32], ['dam', 33], ['facility', 34], ['runway', 35],
    ['surface1', 36], ['jungle', 37], ['temple', 38], ['caverns', 39],
    ['citadel', 40], ['cradle', 41], ['surface2', 43], ['basement', 46],
    ['caves', 51], ['cuba', 56],
]);

// The retail environment tables live in the main 0x1172-compressed data
// segment. These offsets were correlated against runtime 0x80044e10 and
// 0x80045f50 in the ares RDRAM snapshot. Parsing the ROM segment here keeps
// the CRG1 self-contained and avoids browser-side source transcriptions.
const mainDataSegment = inflate1172(rom.subarray(0x21990));
const fogTableOffset = 0x24080;
const foglessTableOffset = 0x251c0;

function rgbBytes(buffer: Buffer, offset: number): number[] {
    return [buffer[offset] / 255, buffer[offset + 1] / 255, buffer[offset + 2] / 255, 1];
}

function rgbFloats(buffer: Buffer, offset: number): number[] {
    return [buffer.readFloatBE(offset) / 255, buffer.readFloatBE(offset + 4) / 255, buffer.readFloatBE(offset + 8) / 255, 1];
}

function parseEnvironment(levelID: number): EnvironmentArchive {
    for (let p = fogTableOffset; p + 0x5c <= mainDataSegment.length; p += 0x5c) {
        const id = mainDataSegment.readInt32BE(p);
        if (id === 0)
            break;
        if (id !== levelID)
            continue;
        return {
            FogEnabled: true,
            Blend: mainDataSegment.readFloatBE(p + 0x04),
            Far: mainDataSegment.readFloatBE(p + 0x08),
            FogMin: mainDataSegment.readInt32BE(p + 0x20),
            FogMax: mainDataSegment.readInt32BE(p + 0x24),
            Sky: rgbBytes(mainDataSegment, p + 0x28),
            CloudEnabled: mainDataSegment[p + 0x2b] !== 0,
            CloudHeight: mainDataSegment.readFloatBE(p + 0x2c),
            SkyImageID: mainDataSegment.readInt16BE(p + 0x30),
            CloudColor: rgbFloats(mainDataSegment, p + 0x34),
            WaterEnabled: mainDataSegment[p + 0x40] !== 0,
            WaterHeight: mainDataSegment.readFloatBE(p + 0x44),
            WaterImageID: mainDataSegment.readInt16BE(p + 0x48),
            WaterColor: rgbFloats(mainDataSegment, p + 0x4c),
            WaterConcavity: mainDataSegment.readFloatBE(p + 0x58),
        };
    }

    let selected = foglessTableOffset;
    for (let p = foglessTableOffset; p + 0x38 <= mainDataSegment.length; p += 0x38) {
        const id = mainDataSegment.readInt32BE(p);
        if (id === 0)
            break;
        if (id === levelID)
            selected = p;
    }
    return {
        FogEnabled: false, Blend: 0, Far: 0, FogMin: 0, FogMax: 0,
        Sky: rgbBytes(mainDataSegment, selected + 0x04),
        CloudEnabled: mainDataSegment[selected + 0x07] !== 0,
        CloudHeight: mainDataSegment.readFloatBE(selected + 0x08),
        SkyImageID: mainDataSegment.readInt16BE(selected + 0x0c),
        CloudColor: rgbFloats(mainDataSegment, selected + 0x10),
        WaterEnabled: mainDataSegment[selected + 0x1c] !== 0,
        WaterHeight: mainDataSegment.readFloatBE(selected + 0x20),
        WaterImageID: mainDataSegment.readInt16BE(selected + 0x24),
        WaterColor: rgbFloats(mainDataSegment, selected + 0x28),
        WaterConcavity: mainDataSegment.readFloatBE(selected + 0x34),
    };
}

function bgOffset(value: number): number {
    return value & 0x00FFFFFF;
}

function inflate1172(src: Buffer): Buffer {
    if (src.length < 3 || src[0] !== 0x11 || src[1] !== 0x72)
        throw new Error(`invalid 1172 stream header ${src.subarray(0, 2).toString('hex')}`);
    return inflateRawSync(src.subarray(2));
}

function parseRooms(bg: Buffer): RoomArchive[] {
    const roomTableOffset = bgOffset(bg.readUInt32BE(4));
    if (roomTableOffset + 0x18 > bg.length)
        throw new Error(`invalid BG room table offset 0x${roomTableOffset.toString(16)}`);

    const entries: { point: number; primary: number; secondary: number; position: number[] }[] = [];
    for (let p = roomTableOffset; p + 0x18 <= bg.length; p += 0x18) {
        const point = bgOffset(bg.readUInt32BE(p));
        const primary = bgOffset(bg.readUInt32BE(p + 4));
        const secondary = bgOffset(bg.readUInt32BE(p + 8));
        entries.push({
            point, primary, secondary,
            position: [bg.readFloatBE(p + 0x0C), bg.readFloatBE(p + 0x10), bg.readFloatBE(p + 0x14)],
        });
        // Entry zero is a dummy. The first later zero primary pointer terminates
        // the table, exactly as load_bg_file's g_MaxNumRooms scan does.
        if (entries.length > 1 && primary === 0)
            break;
    }

    const streamEnd = (index: number, field: 'point' | 'primary' | 'secondary'): number => {
        const start = entries[index][field];
        for (let i = index + 1; i < entries.length; i++) {
            const next = entries[i][field];
            if (next !== 0 && next > start)
                return next;
        }
        return bg.length;
    };
    const unpack = (index: number, field: 'point' | 'primary' | 'secondary'): Buffer => {
        const start = entries[index][field];
        if (start === 0)
            return Buffer.alloc(0);
        return inflate1172(bg.subarray(start, streamEnd(index, field)));
    };

    const result: RoomArchive[] = [];
    // The final nonzero record supplies end offsets for the last room's three
    // streams; the following all-zero record terminates the table.
    for (let i = 1; i + 2 < entries.length; i++) {
        const vertices = unpack(i, 'point');
        const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (let p = 0; p + 0x10 <= vertices.length; p += 0x10) {
            for (let axis = 0; axis < 3; axis++) {
                const value = entries[i].position[axis] + vertices.readInt16BE(p + axis * 2);
                min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
            }
        }
        result.push({
            Index: i,
            Position: entries[i].position,
            Center: min[0] === Infinity ? entries[i].position : min.map((value, axis) => (value + max[axis]) * 0.5),
            Bounds: min[0] === Infinity ? [...entries[i].position, ...entries[i].position] : [...min, ...max],
            Vertices: ArrayBufferSlice.fromView(vertices),
            PrimaryDisplayList: ArrayBufferSlice.fromView(unpack(i, 'primary')),
            SecondaryDisplayList: ArrayBufferSlice.fromView(unpack(i, 'secondary')),
        });
    }
    return result;
}

function parsePortals(bg: Buffer): PortalArchive[] {
    const table = bgOffset(bg.readUInt32BE(8));
    if (table === 0 || table + 8 > bg.length)
        return [];
    const result: PortalArchive[] = [];
    for (let offs = table; offs + 8 <= bg.length; offs += 8) {
        const polygon = bgOffset(bg.readUInt32BE(offs));
        if (polygon === 0)
            break;
        const count = bg.readUInt8(polygon);
        if (count < 3 || count > 32 || polygon + 4 + count * 12 > bg.length)
            throw new Error(`invalid BG portal polygon at 0x${polygon.toString(16)}`);
        const points: number[][] = [];
        for (let i = 0; i < count; i++) {
            const p = polygon + 4 + i * 12;
            points.push([bg.readFloatBE(p), bg.readFloatBE(p + 4), bg.readFloatBE(p + 8)]);
        }
        result.push({ Address: bg.readUInt32BE(offs), Room1: bg.readUInt8(offs + 4), Room2: bg.readUInt8(offs + 5), Flags: bg.readUInt16BE(offs + 6), Points: points });
    }
    return result;
}

function collectTextureIDs(rooms: RoomArchive[], models: ModelArchive[] = [], effectIDs: number[] = []): number[] {
    const ids = new Set<number>();
    for (const id of effectIDs)
        ids.add(id);
    for (const room of rooms) {
        for (const dl of [room.PrimaryDisplayList, room.SecondaryDisplayList]) {
            const view = dl.createDataView();
            for (let offs = 0; offs + 8 <= view.byteLength; offs += 8) {
                const opcode = view.getUint8(offs);
                if (opcode === Fast3DOpcode.GoldenEyeTexture) {
                    const w0 = view.getUint32(offs);
                    const w1 = view.getUint32(offs + 4);
                    ids.add(w1 & 0x0FFF);
                    // Type 1 pairs the base image with a detail image whose ID
                    // is carried in bits 12..23 (texLoadFromGdl .L7F0CE428).
                    if ((w0 & 7) === 1)
                        ids.add((w1 >>> 12) & 0x0FFF);
                }
            }
        }
    }
    for (const model of models) {
        for (const shadow of model.Shadows ?? [])
            ids.add(shadow.TextureID);
        const view = model.Data.createDataView();
        const visited = new Set<number>();
        const scan = (start: number): void => {
            if (start < 0 || start >= view.byteLength || visited.has(start))
                return;
            visited.add(start);
            for (let offs = start; offs + 8 <= view.byteLength; offs += 8) {
                const w0 = view.getUint32(offs);
                const w1 = view.getUint32(offs + 4);
                const op = w0 >>> 24;
                if (op === Fast3DOpcode.GoldenEyeTexture) {
                    ids.add(w1 & 0x0FFF);
                    if ((w0 & 7) === 1)
                        ids.add((w1 >>> 12) & 0x0FFF);
                } else if (op === Fast3DOpcode.DisplayList) {
                    scan(w1 & 0x00FFFFFF);
                    if ((w0 & 1) !== 0)
                        break;
                } else if (op === Fast3DOpcode.EndDisplayList) {
                    break;
                }
            }
        };
        for (const dl of model.DisplayLists)
            scan(dl.Offset);
    }
    return [...ids].sort((a, b) => a - b);
}

const propDefWords = new Map<number, number>([
    [1, 0x40], [2, 2], [3, 0x20], [4, 0x21], [5, 0x20], [6, 0x3B], [7, 0x21], [8, 0x22],
    [9, 7], [10, 0x40], [11, 0x95], [12, 0x20], [13, 0x36], [14, 3], [17, 0x20],
    [18, 3], [19, 4], [20, 0x2D], [21, 0x22], [22, 4], [23, 4], [24, 1], [25, 2],
    [26, 2], [27, 2], [28, 2], [29, 2], [30, 4], [31, 1], [32, 4], [33, 5], [34, 1],
    [35, 4], [36, 0x20], [37, 10], [38, 4], [39, 0x2C], [40, 0x2D], [41, 0x20], [42, 0x20],
    [43, 0x20], [44, 5], [45, 0x38], [46, 7], [47, 0x25], [48, 1],
]);
const objectPropTypes = new Set([1, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 17, 20, 21, 36, 39, 40, 41, 42, 43, 45, 47]);

// weaponAssignToHome indexes the selected eight-entry multiplayer weapon set
// for setup weapon IDs 0xF0..0xF7. The retail default is set 0x0B (Rockets).
const defaultMultiplayerWeapons = [
    { modelID: 205, scale: 3.0 }, { modelID: 205, scale: 3.0 },
    { modelID: 193, scale: 1.5 }, { modelID: 193, scale: 1.5 },
    { modelID: 184, scale: 1.5 }, { modelID: 184, scale: 1.5 },
    { modelID: 211, scale: 1.5 }, { modelID: 211, scale: 1.5 },
];

function vec3(view: DataView, offs: number): number[] {
    return [view.getFloat32(offs), view.getFloat32(offs + 4), view.getFloat32(offs + 8)];
}

const randomBodyPool = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 5, 5, 5, 36, 37, 38, 39, 40];
const randomMaleHeadPool = [56, 53, 54, 61, 58, 55, 57, 52, 51, 50, 41, 42, 43, 44, 45, 46, 47, 48, 49, 62, 63, 64, 65, 66, 67];
const randomFemaleHeadPool = [69, 70, 71, 72];
const femaleBodies = new Set([11, 14, 16, 26, 27, 28, 29, 40, 79]);

// monitorimages[] from image.c, expressed as global g_Textures IDs. Monitor
// setup records store an animation number rather than an image; the initial
// TVCMD_MONITOR_SET_IMAGE command selects one of these entries.
const monitorTextureIDs = [
    2187, 2188, 2189, 2190, 2191, 2192, 2193, 2194, 2195, 2196, 2197, 1185,
    2198, 2199, 1186, 1187, 2200, 582, 583, 584, 2201, 2202, 2203, 2204, 581,
    2205, 2206, 2227, 2223, 2224, 2225, 2226, 2219, 2220, 2221, 2222, 2218,
    2207, 2208, 2209, 2210, 2211, 2212, 2213, 2214, 2215, 2216, 2217, 2263, 837,
];

const monitorAnimationBase = 0x80030B74;
const monitorAnimationEnd = 0x80031F60;
// monitorSetImageByNum's 0..51 switch, including internal effect routines.
const monitorAnimationAddresses = [
    0x80030B74, 0x80030C00, 0x80030E24, 0x80030F44, 0x80031018, 0x80031074,
    0x800310F0, 0x8003118C, 0x8003121C, 0x80031248, 0x80031274, 0x800312F4,
    0x80031310, 0x80031490, 0x800314F8, 0x80030EC8, 0x80031360, 0x8003156C,
    0x800315CC, 0x80031848, 0x80031898, 0x800318B8, 0x8003191C, 0x80031950,
    0x800319D4, 0x800319F0, 0x80031A0C, 0x80031A28, 0x80031A44, 0x80031A60,
    0x80031A7C, 0x80031A98, 0x80031AB4, 0x80031AD0, 0x80031AEC, 0x80031B24,
    0x80031B38, 0x80031B4C, 0x80031B60, 0x80031BB4, 0x80031BD0, 0x80031BEC,
    0x80031C08, 0x80031C80, 0x80031D30, 0x80031D58, 0x80031DA8, 0x80031DF4,
    0x80031E40, 0x80031E78, 0x80031EB0, 0x80031EE8,
];
const monitorAnimationData = mainDataSegment.subarray(monitorAnimationBase - 0x80020D90, monitorAnimationEnd - 0x80020D90);

function initialMonitorTextureID(animation: number, seed: number): number {
    const fixed = new Map<number, number>([
        [0, 0], [1, 12], [2, 17], [3, 28], [4, 28], [5, 29], [6, 29], [7, 29],
        [8, 30], [9, 30], [10, 30], [11, 48], [12, 16], [13, 1], [14, 6],
        [18, 36], [19, 32], [20, 28], [46, 49], [47, 49], [48, 49], [49, 49],
        [50, 49], [51, 0],
    ]);
    let image = fixed.get(animation);
    // The retail scripts choose these with RNG. Stable extraction preserves
    // the intended varied banks without making CRG1 output nondeterministic.
    if (image === undefined && (animation === 15 || animation === 21))
        image = [12, 17, 28, 29, 30, 36, 32][seed % 7];
    else if (image === undefined && (animation === 16 || animation === 22))
        image = [28, 29, 30, 17][seed % 4];
    else if (image === undefined && (animation === 17 || animation === 23))
        image = 17 + seed % 10;
    return monitorTextureIDs[image ?? 0];
}

function stableLevelSeed(id: string): number {
    let hash = 0x811C9DC5;
    for (let i = 0; i < id.length; i++)
        hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193);
    return hash >>> 0;
}

interface StanPlacementInfo { shade: number[]; room: number; heightAt?: (x: number, z: number) => number; }

function parseStanPlacementInfo(stan: Buffer): Map<string, StanPlacementInfo> {
    const colors = new Map<string, StanPlacementInfo>();
    if (stan.byteLength < 12)
        return colors;
    const view = new DataView(stan.buffer, stan.byteOffset, stan.byteLength);
    let offs = view.getUint32(4) & 0x00FFFFFF;
    const sizes = [0x20, 0x20, 0x20, 0x20, 0x28, 0x30, 0x38, 0x40, 0x48, 0x50, 0x58];
    while (offs + 8 <= stan.byteLength && view.getUint32(offs) !== 0) {
        const idHi = view.getUint16(offs);
        const idLo = view.getUint8(offs + 2);
        const mid = view.getUint16(offs + 4);
        const raw = [((mid >>> 8) & 0x0F) * 0x11, ((mid >>> 4) & 0x0F) * 0x11, (mid & 0x0F) * 0x11];
        const luminance = (raw[2] * 21 + raw[0] * 79 + raw[1] * 156) >> 8;
        const shade = [...raw, Math.floor((255 - luminance) * 0.75)];
        const order = [0, 1, 2].sort((a, b) => raw[b] - raw[a]);
        const max = raw[order[0]], min = raw[order[2]];
        if (max !== 0) {
            shade[order[2]] = 0;
            shade[order[1]] = Math.floor(raw[order[1]] * (max - min) / max);
            shade[order[0]] = max - min;
        }
        shade[0] >>= 1; shade[1] >>= 1; shade[2] >>= 1;
        const tail = view.getUint16(offs + 6);
        const pointIndex = tail & 0x0F;
        const cIndex = (tail >>> 4) & 0x0F;
        const dIndex = (tail >>> 8) & 0x0F;
        const point = (index: number): number[] | null => {
            const p = offs + 8 + index * 8;
            return p + 6 <= stan.byteLength ? [view.getInt16(p), view.getInt16(p + 2), view.getInt16(p + 4)] : null;
        };
        const aPoint = point(cIndex), origin = point(dIndex), bPoint = point(pointIndex);
        let heightAt: ((x: number, z: number) => number) | undefined;
        if (aPoint !== null && origin !== null && bPoint !== null) {
            const ax = aPoint[0] - origin[0], ay = aPoint[1] - origin[1], az = aPoint[2] - origin[2];
            const bx = bPoint[0] - origin[0], by = bPoint[1] - origin[1], bz = bPoint[2] - origin[2];
            // stanGetPositionYValue forms this plane from the C, D and
            // point-count-index vertices. Coordinates here remain in the raw
            // STAN/BG domain, so its level_scale/inv_level_scale pair cancels.
            const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
            const plane = nx * origin[0] + ny * origin[1] + nz * origin[2];
            heightAt = ny === 0 ? () => origin[1] : (x, z) => (plane - x * nx - z * nz) / ny;
        }
        colors.set(`${idHi}/${idLo}`, { shade, room: view.getUint8(offs + 3), heightAt });
        // MIPS reads this BE s16 and selects bits 12..15. The C bitfield
        // declaration appears reversed on a little-endian host.
        const size = sizes[(view.getUint16(offs + 6) >>> 12) & 0x0F];
        if (size === undefined)
            break;
        offs += size;
    }
    return colors;
}

function setupPadStanInfo(setup: Buffer, padOffs: number, stanColors: Map<string, StanPlacementInfo>): StanPlacementInfo | undefined {
    const view = new DataView(setup.buffer, setup.byteOffset, setup.byteLength);
    const nameOffs = view.getUint32(padOffs + 0x24) & 0x00FFFFFF;
    if (nameOffs >= setup.byteLength)
        return undefined;
    let name = '';
    for (let i = nameOffs; i < setup.byteLength && setup[i] !== 0 && name.length < 12; i++)
        name += String.fromCharCode(setup[i]);
    const match = /^([pq])(\d+)([a-z])([0-7]?)$/.exec(name);
    if (match === null)
        return undefined;
    const idHi = (match[1] === 'q' ? 0x8000 : 0) | Number(match[2]);
    const idLo = (match[3].charCodeAt(0) - 0x61) * 8 + Number(match[4] || 0);
    return stanColors.get(`${idHi}/${idLo}`);
}

function doorPortalPlane(portals: PortalArchive[], center: number[], doorNormal: number[]): { normal: number[]; min: number } | undefined {
    let best: { normal: number[]; min: number; distance: number } | undefined;
    for (const portal of portals) {
        const [a, b, c] = portal.Points;
        if (a === undefined || b === undefined || c === undefined)
            continue;
        const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const normal = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
        const length = Math.hypot(...normal);
        const doorLength = Math.hypot(...doorNormal);
        if (length < 0.000001 || doorLength < 0.000001)
            continue;
        for (let i = 0; i < 3; i++) normal[i] /= length;
        const alignment = Math.abs((normal[0] * doorNormal[0] + normal[1] * doorNormal[1] + normal[2] * doorNormal[2]) / doorLength);
        if (alignment < 0.9)
            continue;
        const min = normal[0] * a[0] + normal[1] * a[1] + normal[2] * a[2];
        const signedDistance = normal[0] * center[0] + normal[1] * center[1] + normal[2] * center[2] - min;
        const projected = [center[0] - normal[0] * signedDistance, center[1] - normal[1] * signedDistance, center[2] - normal[2] * signedDistance];
        let winding = 0;
        let inside = true;
        for (let i = 0; i < portal.Points.length; i++) {
            const p = portal.Points[i], q = portal.Points[(i + 1) % portal.Points.length];
            const edge = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
            const rel = [projected[0] - p[0], projected[1] - p[1], projected[2] - p[2]];
            const side = normal[0] * (edge[1] * rel[2] - edge[2] * rel[1])
                + normal[1] * (edge[2] * rel[0] - edge[0] * rel[2])
                + normal[2] * (edge[0] * rel[1] - edge[1] * rel[0]);
            if (Math.abs(side) > 0.001) {
                const sign = Math.sign(side);
                if (winding !== 0 && sign !== winding) { inside = false; break; }
                winding = sign;
            }
        }
        if (!inside)
            continue;
        const distance = Math.abs(signedDistance);
        // setupDoor probes only 50 setup units on either side of the pad.
        if (distance <= 50 && (best === undefined || distance < best.distance))
            best = { normal, min, distance };
    }
    return best;
}

function parseSetup(setup: Buffer, stan: Buffer, portals: PortalArchive[], levelID: string): { props: PropArchive[]; guards: PropArchive[]; initialCamera?: { Position: number[]; Look: number[]; Up: number[]; RoomIndex?: number } } {
    if (setup.byteLength < 0x28)
        return { props: [], guards: [] };
    const view = new DataView(setup.buffer, setup.byteOffset, setup.byteLength);
    const propOffset = view.getUint32(0x0C) & 0x00FFFFFF;
    const padsOffset = view.getUint32(0x18) & 0x00FFFFFF;
    const boundPadsOffset = view.getUint32(0x1C) & 0x00FFFFFF;
    if (propOffset >= view.byteLength || padsOffset >= view.byteLength || boundPadsOffset >= view.byteLength)
        return { props: [], guards: [] };
    const props: PropArchive[] = [];
    const guards: PropArchive[] = [];
    const stanColors = parseStanPlacementInfo(stan);
    let initialCamera: { Position: number[]; Look: number[]; Up: number[]; RoomIndex?: number } | undefined;
    const introOffset = view.getUint32(0x08) & 0x00FFFFFF;
    const introSizes = [0x0C, 0x10, 0x10, 0x20, 0x08, 0x08, 0x28, 0x0C, 0x08];
    for (let intro = introOffset, count = 0; intro + 4 <= view.byteLength && count++ < 0x1000;) {
        const type = view.getInt32(intro);
        if (type === SetupType.Guard)
            break;
        if (type === 0 && intro + 0x0C <= view.byteLength && view.getInt32(intro + 8) === 0) {
            const padID = view.getInt32(intro + 4);
            const padOffs = padsOffset + padID * 0x2C;
            if (padID >= 0 && padOffs + 0x2C <= view.byteLength && initialCamera === undefined) {
                const position = vec3(view, padOffs);
                const stanInfo = setupPadStanInfo(setup, padOffs, stanColors);
                if (stanInfo?.heightAt !== undefined)
                    position[1] = stanInfo.heightAt(position[0], position[2]);
                initialCamera = { Position: position, Up: vec3(view, padOffs + 0x0C), Look: vec3(view, padOffs + 0x18), RoomIndex: stanInfo?.room };
            }
        }
        const size = introSizes[type];
        if (size === undefined)
            break;
        intro += size;
    }
    const seed = stableLevelSeed(levelID);
    const levelRandomBody = randomBodyPool[seed % randomBodyPool.length];
    let doorScale = 1;
    for (let offs = propOffset, count = 0; offs + 4 <= view.byteLength && count++ < 0x4000;) {
        const setupIndex = count - 1;
        const type = view.getUint8(offs + 3);
        if (type === SetupType.End)
            break;
        const words = propDefWords.get(type) ?? 1;
        if (type === SetupType.DoorScale && offs + 8 <= view.byteLength) {
            doorScale = view.getInt32(offs + 4) / 65536;
        }
        if (type === SetupType.Guard && offs + 0x1C <= view.byteLength) {
            const padID = view.getInt16(offs + 6);
            const sourceBodyID = view.getUint16(offs + 8);
            // init_guards chooses one current_random_body per stage load; every
            // 0xffff setup record then uses that same body. Use a stable stage
            // seed so cartridge extraction remains byte-reproducible.
            const bodyID = sourceBodyID === 0xFFFF ? levelRandomBody : sourceBodyID;
            const sourceHeadID = view.getInt16(offs + 0x16);
            const headPool = femaleBodies.has(bodyID) ? randomFemaleHeadPool : randomMaleHeadPool;
            const headID = sourceHeadID < 0 ? headPool[(seed + guards.length) % headPool.length] : sourceHeadID;
            const padOffs = padsOffset + padID * 0x2C;
            if (padID >= 0 && padOffs + 0x2C <= view.byteLength) {
                const stanInfo = setupPadStanInfo(setup, padOffs, stanColors);
                const position = vec3(view, padOffs);
                guards.push({
                    Type: type,
                    ModelID: 0x10000 + bodyID,
                    Scale: 1,
                    Position: position,
                    Up: vec3(view, padOffs + 0x0C),
                    Look: vec3(view, padOffs + 0x18),
                    HeadModelID: headID >= 41 && headID <= 72 ? 0x20000 + headID : undefined,
                    ChrNum: view.getUint16(offs + 4),
                    ShadeColor: stanInfo?.shade,
                    RoomIndex: stanInfo?.room,
                    FloorY: stanInfo?.heightAt?.(position[0], position[2]),
                });
            }
        }
        if (objectPropTypes.has(type) && offs + 8 <= view.byteLength) {
            let modelID = view.getInt16(offs + 4);
            let propScale = view.getUint16(offs) / 256;
            const padID = view.getInt16(offs + 6);
            const flags = offs + 0x0C <= view.byteLength ? view.getUint32(offs + 8) : 0;
            const flags2 = offs + 0x10 <= view.byteLength ? view.getUint32(offs + 0x0C) : 0;
            if (levelID.startsWith('mp-') && type === SetupType.Weapon && (flags & PropFlag.AssignedToCharacter) === 0 && offs + 0x81 <= view.byteLength) {
                const weaponSlot = view.getUint8(offs + 0x80) - 0xF0;
                const weapon = defaultMultiplayerWeapons[weaponSlot];
                if (weapon !== undefined) {
                    modelID = weapon.modelID;
                    propScale = weapon.scale;
                }
            }
            let padOffs = -1;
            let bound = false;
            let boundFrame: { origin: number[]; normal: number[]; xmin: number; xmax: number; ymin: number; ymax: number; zmin: number; zmax: number } | undefined;
            const assignedToChr = (flags & PropFlag.AssignedToCharacter) !== 0;
            // DoorRecord.pad is a raw bound-pad index; ordinary ObjectRecord
            // uses the 10000-based bound-pad encoding.
            if (type === SetupType.Door && padID >= 0) {
                padOffs = boundPadsOffset + padID * 0x44;
                bound = true;
            } else if (padID >= 10000) {
                padOffs = boundPadsOffset + (padID - 10000) * 0x44;
                bound = true;
            } else if (padID >= 0) {
                padOffs = padsOffset + padID * 0x2C;
            }
            // Assigned-to-character and embedded objects are reparented by
            // domakedefaultobj; their `pad` field is not a world pad index.
            if (type === SetupType.SingleMonitor && padID < 0 && (flags & PropFlag.Embedded) === 0 && offs + 0x100 <= view.byteLength
                    && modelID >= 0 && modelID < modelMetadata.length) {
                const animationID = view.getInt32(offs + 0xFC);
                props.push({
                    Type: type, ModelID: modelID, Scale: propScale,
                    Position: [0, 0, 0], Up: [0, 1, 0], Look: [0, 0, 1], Flags: flags, Flags2: flags2,
                    SetupIndex: setupIndex, OwnerSetupIndex: setupIndex + view.getInt32(offs + 0xF4),
                    OwnerPart: view.getInt32(offs + 0xF8), MonitorAnimationIDs: [animationID],
                    MonitorTextureIDs: [initialMonitorTextureID(animationID, seed + props.length)],
                });
            } else if (assignedToChr && (type === SetupType.Weapon || type === SetupType.Hat) && modelID >= 0 && modelID < modelMetadata.length) {
                props.push({
                    Type: type, ModelID: modelID, Scale: propScale,
                    Position: [0, 0, 0], Up: [0, 1, 0], Look: [0, 0, 1], ChrNum: padID,
                    AttachmentIndex: type === SetupType.Hat ? AttachmentSlot.Hat : ((flags & PropFlag.AlternateAttachment) !== 0 ? AttachmentSlot.AlternateHand : AttachmentSlot.RightHand), SetupIndex: setupIndex,
                });
            } else if ((assignedToChr || (flags & PropFlag.Embedded) !== 0) && modelID >= 0 && modelID < modelMetadata.length) {
                props.push({
                    Type: type, ModelID: modelID, Scale: propScale,
                    Position: [0, 0, 0], Up: [0, 1, 0], Look: [0, 0, 1], Flags: flags, Flags2: flags2,
                    SetupIndex: setupIndex,
                    OwnerSetupIndex: (flags & PropFlag.Embedded) !== 0 ? setupIndex + padID : undefined,
                    ChrNum: assignedToChr ? padID : undefined,
                    InitiallyHidden: true,
                });
            } else if ((flags & (0x00004000 | 0x00008000)) === 0 && modelID >= 0 && modelID < modelMetadata.length && padOffs >= 0 && padOffs + (bound ? 0x44 : 0x2C) <= view.byteLength) {
                const position = vec3(view, padOffs);
                const padOrigin = [...position];
                const up = vec3(view, padOffs + 0x0C);
                const look = vec3(view, padOffs + 0x18);
                if (bound) {
                    // sub_GAME_7F001BD4 derives the centre in the pad's local
                    // normal/up/look basis from the deliberately swapped bounds.
                    const activeDoorScale = type === SetupType.Door ? doorScale : 1;
                    const xmin = view.getFloat32(padOffs + 0x2C) * activeDoorScale, xmax = view.getFloat32(padOffs + 0x30) * activeDoorScale;
                    const ymin = view.getFloat32(padOffs + 0x34), ymax = view.getFloat32(padOffs + 0x38);
                    const zmin = view.getFloat32(padOffs + 0x3C), zmax = view.getFloat32(padOffs + 0x40);
                    const nx = up[1] * look[2] - up[2] * look[1];
                    const ny = up[2] * look[0] - up[0] * look[2];
                    const nz = up[0] * look[1] - up[1] * look[0];
                    if (type === SetupType.Door && doorScale !== 1 && (flags & PropFlag.AlternateAttachment) !== 0) {
                        const unscaledCenter = [0, 1, 2].map((i) => padOrigin[i] + 0.5 * ((view.getFloat32(padOffs + 0x2C) + view.getFloat32(padOffs + 0x30)) * [nx, ny, nz][i] / (Math.hypot(nx, ny, nz) || 1)
                            + (ymin + ymax) * up[i] + (zmin + zmax) * look[i]));
                        const plane = doorPortalPlane(portals, unscaledCenter, [nx, ny, nz]);
                        if (plane !== undefined) {
                            const distance = padOrigin[0] * plane.normal[0] + padOrigin[1] * plane.normal[1] + padOrigin[2] * plane.normal[2] - plane.min;
                            for (let i = 0; i < 3; i++) {
                                const shifted = padOrigin[i] + plane.normal[i] * distance * (doorScale - 1);
                                padOrigin[i] = shifted;
                                position[i] = shifted;
                            }
                        }
                    }
                    boundFrame = { origin: padOrigin, normal: [nx, ny, nz], xmin, xmax, ymin, ymax, zmin, zmax };
                    const nl = Math.hypot(nx, ny, nz) || 1;
                    position[0] += 0.5 * ((xmin + xmax) * nx / nl + (ymin + ymax) * up[0] + (zmin + zmax) * look[0]);
                    position[1] += 0.5 * ((xmin + xmax) * ny / nl + (ymin + ymax) * up[1] + (zmin + zmax) * look[1]);
                    position[2] += 0.5 * ((xmin + xmax) * nz / nl + (ymin + ymax) * up[2] + (zmin + zmax) * look[2]);
                    // domakedefaultobj passes the bottom centre of an ordinary
                    // bound volume to the standing-object placement path.
                    // Doors are a separate setupDoor path and stay centred.
                    if (type !== SetupType.Door) {
                        const bottom = 0.5 * (ymin - ymax);
                        position[0] += bottom * up[0];
                        position[1] += bottom * up[1];
                        position[2] += bottom * up[2];
                    }
                }
                const prop: PropArchive = { Type: type, ModelID: modelID, Scale: propScale, Position: position, Up: up, Look: look, Flags: flags, Flags2: flags2, SetupIndex: setupIndex };
                const stanInfo = setupPadStanInfo(setup, padOffs, stanColors);
                prop.ShadeColor = stanInfo?.shade;
                prop.RoomIndex = stanInfo?.room;
                prop.FloorY = stanInfo?.heightAt?.(position[0], position[2]);
                // doorSampleRoomLightingColor first uses the ordinary prop
                // sampler, then darkens RGB once more unless OBJFLAG_00000400
                // requests the undarkened result. Alpha is left untouched.
                if (type === SetupType.Door && prop.ShadeColor !== undefined && (flags & PropFlag.SampleUndarkened) === 0) {
                    prop.ShadeColor = [
                        prop.ShadeColor[0] >>> 1,
                        prop.ShadeColor[1] >>> 1,
                        prop.ShadeColor[2] >>> 1,
                        prop.ShadeColor[3],
                    ];
                }
                if (bound) {
                    const activeDoorScale = type === SetupType.Door ? doorScale : 1;
                    prop.BoundSize = [
                        Math.abs((view.getFloat32(padOffs + 0x30) - view.getFloat32(padOffs + 0x2C)) * activeDoorScale),
                        Math.abs(view.getFloat32(padOffs + 0x38) - view.getFloat32(padOffs + 0x34)),
                        Math.abs(view.getFloat32(padOffs + 0x40) - view.getFloat32(padOffs + 0x3C)),
                    ];
                }
                if (type === SetupType.Door && offs + 0xA0 <= view.byteLength) {
                    if (doorScale !== 1)
                        prop.DoorScale = doorScale;
                    prop.LinkedDoorOffset = view.getInt32(offs + 0x80);
                    prop.MaxOpenFraction = view.getInt32(offs + 0x84) / 65536;
                    prop.DoorFlags = view.getUint16(offs + 0x98);
                    prop.DoorType = view.getUint16(offs + 0x9A);
                    if (boundFrame !== undefined) {
                        // setupDoor computes the runtime movement vector from
                        // the deliberately remapped bb2 bounds. Vertical and
                        // fallaway panels move along pad look; ordinary sliding
                        // classes move down pad up. openPosition is a fraction
                        // for these classes and multiplies this full span.
                        const distance = prop.DoorType === 4 || prop.DoorType === 8
                            ? boundFrame.zmax - boundFrame.zmin
                            : boundFrame.ymin - boundFrame.ymax;
                        const axis = prop.DoorType === 4 || prop.DoorType === 8 ? look : up;
                        prop.DoorTravel = [axis[0] * distance, axis[1] * distance, axis[2] * distance];
                        if (prop.DoorType === 5 || prop.DoorType === 9) {
                            const hingeX = prop.DoorType === 9 || (flags & PropFlag.AlternateDoorHinge) !== 0 ? boundFrame.xmax : boundFrame.xmin;
                            prop.DoorPivot = [0, 1, 2].map((i) => boundFrame!.origin[i] + up[i] * boundFrame!.ymin + boundFrame!.normal[i] * hingeX);
                        }
                    }
                    if ((prop.DoorFlags & 0x0002) !== 0 && offs + 0xC6 <= view.byteLength) {
                        prop.TintDistance = view.getInt32(offs + 0xC0);
                        prop.OpaqueDistance = view.getInt16(offs + 0xC4);
                        prop.MinimumOpacity = 0;
                    }
                }
                if (type === SetupType.TintedGlass && offs + 0x94 <= view.byteLength) {
                    prop.TintDistance = view.getInt32(offs + 0x80);
                    prop.OpaqueDistance = view.getInt32(offs + 0x84);
                    prop.MinimumOpacity = view.getInt32(offs + 0x90) / 65536;
                }
                if (type === SetupType.SingleMonitor && offs + 0x100 <= view.byteLength) {
                    const animationID = view.getInt32(offs + 0xFC);
                    prop.MonitorAnimationIDs = [animationID];
                    prop.MonitorTextureIDs = [initialMonitorTextureID(animationID, seed + props.length)];
                } else if (type === SetupType.MultiMonitor && offs + 0x254 <= view.byteLength) {
                    prop.MonitorAnimationIDs = [0, 1, 2, 3].map((i) => view.getUint8(offs + 0x250 + i));
                    prop.MonitorTextureIDs = prop.MonitorAnimationIDs.map((animationID, i) => initialMonitorTextureID(animationID, seed + props.length * 4 + i));
                }
                props.push(prop);
            }
        }
        offs += words * 4;
    }
    return { props, guards, initialCamera };
}

type Matrix4 = number[];

const identityMatrix = (): Matrix4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiplyMatrix(a: Matrix4, b: Matrix4): Matrix4 {
    const out = new Array<number>(16);
    for (let column = 0; column < 4; column++)
        for (let row = 0; row < 4; row++)
            out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1]
                + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
    return out;
}

function invertRigidMatrix(m: Matrix4): Matrix4 {
    const out = [
        m[0], m[4], m[8], 0,
        m[1], m[5], m[9], 0,
        m[2], m[6], m[10], 0,
        0, 0, 0, 1,
    ];
    out[12] = -(out[0] * m[12] + out[4] * m[13] + out[8] * m[14]);
    out[13] = -(out[1] * m[12] + out[5] * m[13] + out[9] * m[14]);
    out[14] = -(out[2] * m[12] + out[6] * m[13] + out[10] * m[14]);
    return out;
}

// matrix_4x4_set_rotation_around_xyz from the game. Rare's Mtxf is multiplied
// with row vectors; retaining its contiguous row-major bytes makes the same
// transform a column-vector gl-matrix (including translation at indices 12-14).
function groupMatrix(origin: number[], rotation: number[]): Matrix4 {
    const [x, y, z] = rotation;
    const xc = Math.cos(x), xs = Math.sin(x), yc = Math.cos(y), ys = Math.sin(y), zc = Math.cos(z), zs = Math.sin(z);
    const a = xs * zs, b = xc * zs, c = xs * zc, d = xc * zc;
    return [
        yc * zc, yc * zs, -ys, 0,
        c * ys - xc * zs, a * ys + xc * zc, xs * yc, 0,
        d * ys + xs * zs, b * ys - xs * zc, xc * yc, 0,
        origin[0], origin[1], origin[2], 1,
    ];
}

// Opcode-2 group origins are joint pivots in model space, not ordinary child
// translations. process_02_position rotates the already model-space vertices
// about that pivot, so an unanimated static group must reduce to identity.
function groupPivotMatrix(origin: number[], rotation: number[]): Matrix4 {
    const matrix = groupMatrix([0, 0, 0], rotation);
    matrix[12] = origin[0] - (matrix[0] * origin[0] + matrix[4] * origin[1] + matrix[8] * origin[2]);
    matrix[13] = origin[1] - (matrix[1] * origin[0] + matrix[5] * origin[1] + matrix[9] * origin[2]);
    matrix[14] = origin[2] - (matrix[2] * origin[0] + matrix[6] * origin[1] + matrix[10] * origin[2]);
    return matrix;
}

// modelRenderNodeType2 stores a second render_pos matrix for the joints marked
// 0x100. The original builds it by slerping from the identity quaternion to
// the joint rotation at t=0.5, then concatenating that rotation with the
// parent. Geometry around elbows/shoulders explicitly selects these matrices.
function halfRotationMatrix(rotation: number[]): Matrix4 {
    const [x, y, z] = rotation;
    const cx = Math.cos(x * 0.5), sx = Math.sin(x * 0.5);
    const cy = Math.cos(y * 0.5), sy = Math.sin(y * 0.5);
    const cz = Math.cos(z * 0.5), sz = Math.sin(z * 0.5);
    let q = [
        cx * cy * cz + sx * sy * sz,
        sx * cy * cz - cx * sy * sz,
        cx * sy * cz + sx * cy * sz,
        cx * cy * sz - sx * sy * cz,
    ];
    // quaternion_7F05BC68(q, 0.5): choose the shortest identity-to-q arc.
    if (q[0] < 0)
        q = q.map((v) => -v);
    const angle = Math.acos(Math.max(-1, Math.min(1, q[0])));
    if (angle > 0.00001001) {
        const scale = Math.sin(angle * 0.5) / Math.sin(angle);
        q = [Math.cos(angle * 0.5), q[1] * scale, q[2] * scale, q[3] * scale];
    } else {
        q = [(q[0] + 1) * 0.5, q[1] * 0.5, q[2] * 0.5, q[3] * 0.5];
    }
    const [w, qx, qy, qz] = q;
    const n = 2 / (w * w + qx * qx + qy * qy + qz * qz);
    const wx = w * qx * n, wy = w * qy * n, wz = w * qz * n;
    const xx = qx * qx * n, xy = qx * qy * n, xz = qx * qz * n;
    const yy = qy * qy * n, yz = qy * qz * n, zz = qz * qz * n;
    return [
        1 - yy - zz, xy + wz, xz - wy, 0,
        xy - wz, 1 - xx - zz, yz + wx, 0,
        xz + wy, yz - wx, 1 - xx - yy, 0,
        0, 0, 0, 1,
    ];
}

const guardJointChannels = [0, 0, 3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36, 39, 42];
const idleFrame0 = rom.subarray(0x124AC0, 0x124AC0 + 68);

function readAnimationBits(data: Uint8Array, bitOffset: number, bitLength: number): number {
    let result = 0;
    for (let i = 0; i < bitLength; i++) {
        const bit = bitOffset + i;
        result = (result << 1) | ((data[bit >>> 3] >>> (7 - (bit & 7))) & 1);
    }
    return result;
}

function idleGuardRotation(jointID: number): number[] {
    if (jointID < 0 || jointID >= guardJointChannels.length)
        return [0, 0, 0];
    const channel = guardJointChannels[jointID];
    const scale = Math.PI * 2 / 0x1000;
    return [0, 1, 2].map((axis) => readAnimationBits(idleFrame0, (channel + axis) * 12, 12) * scale);
}

function extractModelFromMetadata(meta: [number, string, number, number, number, number, number], archiveID: number, character = false, attachmentSpace = character, animatedMonitor = false): ModelArchive {
    const [, name, offset, size, switches, textures, scale] = meta;
    const packed = rom.subarray(offset, offset + size);
    if (packed[0] !== 0x11 || packed[1] !== 0x72)
        throw new Error(`model ${archiveID} (${name}) has invalid compression header`);
    const data = Buffer.from(inflateRawSync(packed.subarray(2)));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const root = switches * 4 + textures * 0x0C;
    // A display list can be referenced by more than one group. Keep the group
    // transform in the identity so articulated/shared geometry is not dropped.
    const displayLists = new Map<string, ModelDisplayListArchive>();
    const visited = new Set<number>();
    let attachmentMatrix: Matrix4 | undefined;
    let bounds: number[] | undefined;
    const ptr = (offs: number): number => view.getUint32(offs) & 0x00FFFFFF;
    const attachmentMatrices: number[][] = [];
    const matrices: number[][] = [];
    let runtimeMatrixZero: Matrix4 | undefined;
    const shadows: ModelShadowArchive[] = [];
    const nodeTypes: number[] = [];
    const screens: ModelScreenArchive[] = [];
    const bspPlanes: ModelBSPPlaneArchive[] = [];
    const switchNodes = new Map<number, number>();
    for (let i = 0; i < switches; i++) {
        const switchNode = ptr(i * 4);
        if (switchNode !== 0)
            switchNodes.set(switchNode, i);
    }
    const walk = (node: number, parentMatrix: Matrix4, lodMin = 0, lodMax = Infinity, bspPath: ModelBSPPathArchive[] = [], stopNext = 0, runtimeParentMatrix: Matrix4 = parentMatrix): void => {
        if (node < 0 || node + 0x18 > view.byteLength || visited.has(node))
            return;
        visited.add(node);
        // Upper opcode bits are per-node behavior flags; the low byte selects
        // the relation record type (as in modelAttachPart/model traversal).
        const nodeOpcode = view.getUint16(node);
        const opcode = nodeOpcode & 0xFF;
        nodeTypes.push(opcode);
        const rodata = ptr(node + 4);
        let childMatrix = parentMatrix;
        let runtimeChildMatrix = runtimeParentMatrix;
        let childLODMin = lodMin, childLODMax = lodMax;
        const attachmentIndex = switchNodes.get(node);
        if (opcode === 2 && rodata + 0x0C <= view.byteLength) {
            const origin = [view.getFloat32(rodata), view.getFloat32(rodata + 4), view.getFloat32(rodata + 8)];
            const jointID = rodata + 0x0E <= view.byteLength ? view.getUint16(rodata + 0x0C) : -1;
            const rotation = character ? idleGuardRotation(jointID) : [0, 0, 0];
            // Character archives use their baked animation relation matrices;
            // static object origins are model-space rotation pivots.
            const relation = attachmentSpace ? groupMatrix(origin, rotation) : groupPivotMatrix(origin, rotation);
            childMatrix = multiplyMatrix(parentMatrix, relation);
            runtimeChildMatrix = multiplyMatrix(runtimeParentMatrix, groupMatrix(origin, rotation));
            if (rodata + 0x10 <= view.byteLength) {
                const matrixID = view.getInt16(rodata + 0x0E);
                if (matrixID >= 0) {
                    matrices[matrixID] = [...runtimeChildMatrix];
                    if (matrixID === 0)
                        runtimeMatrixZero = [...runtimeChildMatrix];
                }
            }
            if ((nodeOpcode & 0x100) !== 0 && rodata + 0x12 <= view.byteLength) {
                const matrixID = view.getInt16(rodata + 0x10);
                if (matrixID >= 0)
                matrices[matrixID] = multiplyMatrix(runtimeParentMatrix, halfRotationMatrix(rotation));
            }
        } else if (opcode === ModelNodeType.GunFirePosition && rodata + 0x10 <= view.byteLength) {
            // process_15_subposition: the simple group has no animation or
            // rotation channels, but still contributes an authored origin and
            // publishes its resulting render_pos matrix for descendant G_MTX.
            const origin = [view.getFloat32(rodata), view.getFloat32(rodata + 4), view.getFloat32(rodata + 8)];
            childMatrix = multiplyMatrix(parentMatrix, groupMatrix(origin, [0, 0, 0]));
            runtimeChildMatrix = multiplyMatrix(runtimeParentMatrix, groupMatrix(origin, [0, 0, 0]));
            const matrixID = view.getInt16(rodata + 0x0C);
            if (matrixID >= 0)
                matrices[matrixID] = [...runtimeChildMatrix];
        }
        if (attachmentIndex !== undefined)
            attachmentMatrices[attachmentIndex] = [...runtimeChildMatrix];
        if (opcode === ModelNodeType.HeadSpot)
            attachmentMatrix = [...parentMatrix];
        // chrobjGetBboxFromObjFile returns RootNode->Child->Data. Models may
        // contain nested opcode-0x0A boxes for individual parts; those do not
        // replace the object's placement/collision bounds.
        if (opcode === ModelNodeType.BoundingBox && bounds === undefined && rodata + 0x1C <= view.byteLength)
            bounds = [0, 1, 2, 3, 4, 5].map((i) => view.getFloat32(rodata + 4 + i * 4));
        if (opcode === ModelNodeType.DisplayList && rodata + 0x20 <= view.byteLength) {
            const image = ptr(rodata + 0x10);
            if (image + 4 <= view.byteLength) {
                shadows.push({
                    Position: [view.getFloat32(rodata), view.getFloat32(rodata + 4)],
                    Size: [view.getFloat32(rodata + 8), view.getFloat32(rodata + 0x0C)],
                    TextureID: view.getUint32(image) & 0x0FFF,
                    Matrix: [...parentMatrix],
                });
            }
        }
        let bspIndex = -1;
        if (opcode === 9 && rodata + 0x24 <= view.byteLength) {
            bspIndex = bspPlanes.length;
            bspPlanes.push({
                Point: [view.getFloat32(rodata), view.getFloat32(rodata + 4), view.getFloat32(rodata + 8)],
                Vector: [view.getFloat32(rodata + 0x0C), view.getFloat32(rodata + 0x10), view.getFloat32(rodata + 0x14)],
                Mode: view.getInt16(rodata + 0x20),
                Matrix: [...parentMatrix],
            });
        }
        if (opcode === 8 && rodata + 0x10 <= view.byteLength) {
            const min = view.getFloat32(rodata);
            const max = view.getFloat32(rodata + 4);
            childLODMin = Math.max(childLODMin, min);
            childLODMax = Math.min(childLODMax, max);
        }
        const lod = lodMin !== 0 || lodMax !== Infinity ? { LODMin: lodMin, LODMax: lodMax } : {};
        const displayListMatrix = parentMatrix;
        const displayListMatrixKey = displayListMatrix.join('/');
        // chrobjRenderModel appends a separate dynamic quad for switch-table
        // opcode-0x18 nodes. Preserve the immutable vertex source separately;
        // the node's ordinary display lists still render casing/base geometry.
        if (opcode === ModelNodeType.Attachment && attachmentIndex !== undefined && animatedMonitor && rodata + 0x0C <= view.byteLength) {
            const vertexBase = ptr(rodata + 8);
            if (vertexBase + 0x40 <= view.byteLength)
                screens.push({ Index: attachmentIndex, VertexBase: vertexBase, Matrix: [...parentMatrix] });
        }
        if (rodata + 4 <= view.byteLength) {
            if (opcode === 4) {
                const vertexBase = ptr(rodata + 0x0C);
                const modelType = rodata + 0x13 <= view.byteLength ? view.getInt8(rodata + 0x12) : 0;
                for (const [dl, secondary] of [[ptr(rodata), false], [ptr(rodata + 4), true]] as const)
                    if (dl > 0 && dl < view.byteLength) displayLists.set(`${dl}/${displayListMatrixKey}/${secondary}/${lodMin}/${lodMax}/${bspPath.map((v) => `${v.Index}:${v.Side}`).join(',')}`, { Offset: dl, VertexBase: vertexBase, Matrix: [...displayListMatrix], ModelType: modelType, Secondary: secondary, BSPPath: [...bspPath], ...lod });
            } else if (opcode === ModelNodeType.Position) {
                const dl = ptr(rodata + 8);
                const vertexBase = ptr(rodata + 4);
                if (dl > 0 && dl < view.byteLength) displayLists.set(`${dl}/${displayListMatrixKey}/${lodMin}/${lodMax}/${bspPath.map((v) => `${v.Index}:${v.Side}`).join(',')}`, { Offset: dl, VertexBase: vertexBase, Matrix: [...displayListMatrix], BSPPath: [...bspPath], ...lod });
            } else if (opcode === ModelNodeType.Attachment && (attachmentIndex === undefined || !animatedMonitor)) {
                const vertexBase = ptr(rodata + 8);
                const modelType = rodata + 0x1A <= view.byteLength ? view.getInt16(rodata + 0x18) : 0;
                for (const [dl, secondary] of [[ptr(rodata), false], [ptr(rodata + 4), true]] as const)
                    if (dl > 0 && dl < view.byteLength) displayLists.set(`${dl}/${displayListMatrixKey}/${secondary}/${lodMin}/${lodMax}/${bspPath.map((v) => `${v.Index}:${v.Side}`).join(',')}`, { Offset: dl, VertexBase: vertexBase, Matrix: [...displayListMatrix], ModelType: modelType, Secondary: secondary, BSPPath: [...bspPath], ...lod });
            }
        }
        let child = ptr(node + 0x14);
        if (opcode === 8 && rodata + 0x0C <= view.byteLength)
            child = ptr(rodata + 8);
        else if (opcode === ModelNodeType.Distance && rodata + 4 <= view.byteLength)
            child = ptr(rodata);
        const next = ptr(node + 0x0C);
        if (bspIndex >= 0) {
            const left = ptr(rodata + 0x18), right = ptr(rodata + 0x1C);
            if (left !== 0) walk(left, childMatrix, childLODMin, childLODMax, [...bspPath, { Index: bspIndex, Side: 0 }], right, runtimeChildMatrix);
            if (right !== 0) walk(right, childMatrix, childLODMin, childLODMax, [...bspPath, { Index: bspIndex, Side: 1 }], left, runtimeChildMatrix);
        } else if (child !== 0) {
            walk(child, childMatrix, childLODMin, childLODMax, bspPath, 0, runtimeChildMatrix);
        }
        if (next !== 0 && next !== stopNext) walk(next, parentMatrix, lodMin, lodMax, bspPath, stopNext, runtimeParentMatrix);
    };
    walk(root, identityMatrix());
    if (!character && runtimeMatrixZero !== undefined) {
        const inverseRoot = invertRigidMatrix(runtimeMatrixZero);
        for (let i = 0; i < matrices.length; i++)
            if (matrices[i] !== undefined)
                matrices[i] = multiplyMatrix(inverseRoot, matrices[i]);
        for (let i = 0; i < attachmentMatrices.length; i++)
            if (attachmentMatrices[i] !== undefined)
                attachmentMatrices[i] = multiplyMatrix(inverseRoot, attachmentMatrices[i]);
    }
    // process_monitor_animation_microcode emits gSPMatrix(model->render_pos)
    // without an index, so its copied quad uses relation matrix slot zero,
    // not the opcode-0x18 node's traversal parent.
    const monitorMatrix = matrices[0] ?? identityMatrix();
    for (const screen of screens)
        screen.Matrix = [...monitorMatrix];
    let doorClip: { VertexBase: number; VertexCount: number } | undefined;
    const boundsNode = ptr(root + 0x14);
    const collisionNode = boundsNode > 0 && boundsNode + 0x18 <= view.byteLength ? ptr(boundsNode + 0x14) : 0;
    if (collisionNode > 0 && collisionNode + 0x18 <= view.byteLength && (view.getUint16(collisionNode) & 0xFF) === 0x18) {
        const collisionData = ptr(collisionNode + 4);
        if (collisionData > 0 && collisionData + 0x10 <= view.byteLength) {
            const vertexBase = ptr(collisionData + 8);
            const vertexCount = view.getInt16(collisionData + 0x0C);
            if (vertexCount > 0 && vertexBase + vertexCount * 0x10 <= view.byteLength)
                doorClip = { VertexBase: vertexBase, VertexCount: vertexCount };
        }
    }
    return { ID: archiveID, Name: name, Scale: scale, Data: ArrayBufferSlice.fromView(data), DisplayLists: [...displayLists.values()], Matrices: matrices, AttachmentMatrix: attachmentMatrix, Bounds: bounds, AttachmentMatrices: attachmentMatrices, Shadows: shadows, NodeTypes: nodeTypes, Screens: screens, BSPPlanes: bspPlanes, DoorClip: doorClip };
}

function extractModel(id: number, attachmentSpace = false, animatedMonitor = false): ModelArchive {
    return extractModelFromMetadata(modelMetadata[id], id, false, attachmentSpace, animatedMonitor);
}

function extractCharacter(bodyID: number): ModelArchive {
    const meta = characterMetadata.find((entry: [number, string, number, number, number, number, number]) => entry[0] === bodyID);
    if (meta === undefined)
        throw new Error(`missing character metadata for body ${bodyID}`);
    return extractModelFromMetadata(meta, 0x10000 + bodyID, true);
}

function extractHead(headID: number): ModelArchive {
    const meta = headMetadata.find((entry: [number, string, number, number, number, number, number]) => entry[0] === headID);
    if (meta === undefined)
        throw new Error(`missing head metadata for head ${headID}`);
    return extractModelFromMetadata(meta, 0x20000 + headID, false, true);
}

function extractTextures(ids: number[]): TextureArchive[] {
    return ids.map((id) => {
        if (id < 0 || id + 1 >= imageOffsets.length)
            throw new Error(`texture ID ${id} is outside g_Textures`);
        const start = imagesSegmentRomStart + imageOffsets[id];
        const end = imagesSegmentRomStart + imageOffsets[id + 1];
        let decoded;
        try {
            decoded = decodeGoldenEyeTexture(rom.subarray(start, end), (data: Uint8Array) => inflateRawSync(data));
        } catch (e) {
            throw new Error(`failed to decode texture ${id} at 0x${start.toString(16)}..0x${end.toString(16)}: ${e}`);
        }
        const lod1 = decoded.lods[0];
        return {
            ID: id, Width: decoded.width, Height: decoded.height, Pixels: ArrayBufferSlice.fromView(decoded.pixels),
            LOD1Width: lod1?.width, LOD1Height: lod1?.height,
            LOD1Pixels: lod1 === undefined ? undefined : ArrayBufferSlice.fromView(lod1.pixels),
        };
    });
}

mkdirSync(outputRoot, { recursive: true });
const globalImageTable = Buffer.from(rom.subarray(2740576, 2740576 + 2760));
for (const level of levels) {
    const background = extractFile(level.bg);
    const rooms = parseRooms(background);
    const portals = parsePortals(background);
    const visibilityOffs = bgOffset(background.readUInt32BE(0x0C));
    const sectionOffsets = [4, 8, 0x10, 0x14].map((field) => bgOffset(background.readUInt32BE(field)))
        .filter((offs) => offs > visibilityOffs && offs <= background.byteLength);
    const visibilityEnd = sectionOffsets.length === 0 ? background.byteLength : Math.min(...sectionOffsets);
    const globalVisibility = visibilityOffs === 0 ? Buffer.alloc(0) : background.subarray(visibilityOffs, visibilityEnd);
    const setup = level.setup === undefined ? Buffer.alloc(0) : extractFile(level.setup);
    const stan = extractFile(level.stan);
    const { props, guards, initialCamera } = parseSetup(setup, stan, portals, level.id);
    const attachmentModelIDs = new Set(props.filter((prop) => prop.AttachmentIndex !== undefined).map((prop) => prop.ModelID));
    const animatedMonitorModelIDs = new Set(props.filter((prop) => prop.MonitorAnimationIDs !== undefined).map((prop) => prop.ModelID));
    const models = [...new Set(props.map((prop) => prop.ModelID))].sort((a, b) => a - b)
        .map((id) => extractModel(id, attachmentModelIDs.has(id), animatedMonitorModelIDs.has(id)));
    const characters = [...new Set(guards.map((guard) => guard.ModelID - 0x10000))].sort((a, b) => a - b).map(extractCharacter);
    const heads = [...new Set(guards.flatMap((guard) => guard.HeadModelID === undefined ? [] : [guard.HeadModelID - 0x20000]))].sort((a, b) => a - b).map(extractHead);
    const levelID = level.environmentID ?? levelIDs.get(level.id);
    if (levelID === undefined)
        throw new Error(`missing LEVELID for ${level.id}`);
    const environment = parseEnvironment(levelID);
    // ROM s_skywaterimages: clouds, grayscale water, blue water.
    const skyWaterTextureIDs = [2228, 1508, 1509];
    const effectTextureIDs: number[] = [];
    if (environment.CloudEnabled)
        effectTextureIDs.push(skyWaterTextureIDs[environment.SkyImageID]);
    if (environment.WaterEnabled)
        effectTextureIDs.push(skyWaterTextureIDs[environment.WaterImageID]);
    const archive: LevelArchive = {
        Version: archiveVersion,
        ID: level.id,
        Name: level.name,
        Code: level.code,
        Scale: level.scale,
        VisibilityScale: level.visibility,
        Environment: environment,
        Stan: ArrayBufferSlice.fromView(stan),
        Setup: ArrayBufferSlice.fromView(setup),
        GlobalImageTable: ArrayBufferSlice.fromView(globalImageTable),
        Textures: extractTextures(collectTextureIDs(rooms, [...models, ...characters, ...heads], [...effectTextureIDs, ...(props.some((prop) => prop.MonitorAnimationIDs !== undefined) ? monitorTextureIDs : [])])),
        Rooms: rooms,
        Portals: portals,
        GlobalVisibility: ArrayBufferSlice.fromView(globalVisibility),
        Models: models,
        Props: props,
        Characters: characters,
        Heads: heads,
        Guards: guards,
        MonitorAnimationData: ArrayBufferSlice.fromView(monitorAnimationData),
        MonitorAnimationRoots: monitorAnimationAddresses.map((address) => address - monitorAnimationBase),
        InitialCamera: initialCamera,
    };
    const crg1 = BYML.write(archive, BYML.FileType.CRG1);
    const filename = join(outputRoot, `${level.id}.crg1`);
    writeFileSync(filename, zstdCompressSync(new Uint8Array(crg1)));
    const roomBytes = archive.Rooms.reduce((n, room) => n + room.Vertices.byteLength + room.PrimaryDisplayList.byteLength + room.SecondaryDisplayList.byteLength, 0);
    const attachmentCount = archive.Characters.filter((model) => model.AttachmentMatrix !== undefined).length;
    const equipmentAttachmentCount = archive.Characters.filter((model) => model.AttachmentMatrices?.[3] !== undefined || model.AttachmentMatrices?.[5] !== undefined || model.AttachmentMatrices?.[6] !== undefined).length;
    const headDisplayListCount = archive.Heads.reduce((n, model) => n + model.DisplayLists.length, 0);
    const shadedPlacementCount = [...archive.Props, ...archive.Guards].filter((prop) => prop.ShadeColor !== undefined).length;
    console.log(`${basename(filename)}: ${archive.Rooms.length} rooms/${archive.Portals.length} portals, ${archive.Props.length} props, ${archive.Guards.length} guards/${shadedPlacementCount} STAN-lit placements, ${archive.Models.length} prop models, ${archive.Characters.length} character models (${attachmentCount} detachable/${equipmentAttachmentCount} equipped), ${archive.Heads.length} head models/${headDisplayListCount} display lists, ${archive.Textures.length} textures, ${roomBytes} unpacked room bytes, stan ${archive.Stan.byteLength}, setup ${archive.Setup.byteLength}`);
}
writeFileSync(join(outputRoot, 'manifest.json'), JSON.stringify(levels.map(({ id, name }) => ({ id, name })), null, 2));
