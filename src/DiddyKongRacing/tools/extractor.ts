import { spawnSync } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { PNG } from 'pngjs';

const version = 'us_1.1';
const pathBaseIn = `./data/DiddyKongRacing_Raw/assets/${version}`;
const pathBaseOut = `./data/DiddyKongRacing/${version}`;
const frameSize = 0x100;
const framesPerRow = 0x20;

interface AssetSection {
    filenames?: string[];
    folder?: string;
    type: string;
}

interface AssetsJson {
    assets: AssetSection[];
}

interface SpriteRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

function main(): void {
    const assets = JSON.parse(readFileSync(join(pathBaseIn, 'assets.json'), 'utf8')) as AssetsJson;
    const textureSection = assets.assets[4];
    const spriteSection = assets.assets[12];
    if (textureSection.type !== 'Textures' || textureSection.folder !== 'textures/2d' ||
        spriteSection.type !== 'Sprites' || spriteSection.folder !== 'sprites')
        throw new Error('unsupported DKR assets.json layout');

    const spriteFiles = spriteSection.filenames!;
    let frameCount = 0;
    for (const filename of spriteFiles)
        frameCount += readFileSync(join(pathBaseIn, 'sprites', filename)).readUInt16BE(0x02);

    const sheetWidth = framesPerRow * frameSize;
    const sheetHeight = Math.ceil(frameCount / framesPerRow) * frameSize;
    const sheet = new PNG({ width: sheetWidth, height: sheetHeight });
    const sprites: SpriteRect[][] = [];
    let frameIndex = 0;

    for (const filename of spriteFiles) {
        const sprite = readFileSync(join(pathBaseIn, 'sprites', filename));
        const baseTexture = sprite.readUInt16BE(0x00);
        const numberOfFrames = sprite.readUInt16BE(0x02);
        const anchorX = sprite.readInt16BE(0x04);
        const anchorY = sprite.readInt16BE(0x06);
        const frames: SpriteRect[] = [];

        for (let frame = 0; frame < numberOfFrames; frame++, frameIndex++) {
            const sheetX = (frameIndex % framesPerRow) * frameSize;
            const sheetY = Math.floor(frameIndex / framesPerRow) * frameSize;
            frames.push({ x: sheetX, y: sheetY, w: frameSize, h: frameSize });

            for (let tile = sprite[0x0C + frame]; tile < sprite[0x0D + frame]; tile++) {
                const textureIndex = baseTexture + tile;
                const textureName = textureSection.filenames![textureIndex];
                const texturePath = join(pathBaseIn, textureSection.folder, textureName);
                const header = readFileSync(`${texturePath}.header`);
                const image = PNG.sync.read(readFileSync(texturePath));
                const x = sheetX + frameSize / 2 + header.readInt8(0x03) - anchorX;
                const y = sheetY + frameSize / 2 + header.readInt8(0x04) - anchorY;
                if (x < sheetX || y < sheetY || x + image.width > sheetX + frameSize || y + image.height > sheetY + frameSize)
                    throw new Error(`sprite tile ${textureIndex} exceeds its frame`);
                PNG.bitblt(image, sheet, 0, 0, image.width, image.height, x, y);
            }
        }
        sprites.push(frames);
    }

    mkdirSync(pathBaseOut, { recursive: true });
    writeFileSync(join(pathBaseIn, 'dkr_sprites.png'), PNG.sync.write(sheet));
    writeFileSync(join(pathBaseIn, 'dkr_sprites.json'), JSON.stringify({ sprites }));
    const zipPath = resolve(pathBaseOut, 'data.zip');
    mkdirSync(dirname(zipPath), { recursive: true });
    const zip = spawnSync('zip', ['-q', '-r', '-FS', zipPath, '.'], { cwd: pathBaseIn });
    if (zip.status !== 0)
        throw zip.error ?? new Error(zip.stderr.toString());
    console.log(`Packed ${spriteFiles.length} sprites (${frameCount} frames) into ${zipPath}`);
}

main();
