import { PokemonStadiumBattleTextArchive } from './battle_text.js';

export class BattleTextRenderer {
    private overlay: HTMLDivElement | null = null;
    private label: HTMLCanvasElement | null = null;
    private resize: (() => void) | null = null;
    private enabled = true;
    private moveID = -1;
    private renderedMoveID: number | null = null;
    private tileImages: HTMLCanvasElement[] = [];
    private glyphImages: HTMLCanvasElement[] = [];

    constructor(private archive: PokemonStadiumBattleTextArchive, private speciesID: number) {}

    public setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (this.overlay !== null) this.overlay.style.display = enabled ? '' : 'none';
        if (enabled) {
            this.renderedMoveID = null;
            this.update(this.moveID);
        }
    }

    public mount(): void {
        if (this.overlay !== null) return;
        const frame = document.createElement('div');
        frame.dataset.pokemonStadiumBattleText = 'true';
        Object.assign(frame.style, {
            position: 'fixed', bottom: '92px', zIndex: '20', pointerEvents: 'none',
            display: this.enabled ? '' : 'none',
        });
        const label = document.createElement('canvas');
        label.width = 224;
        label.height = 23;
        Object.assign(label.style, {
            display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated',
        });
        frame.appendChild(label);
        document.body.appendChild(frame);
        this.resize = () => {
            const scale = Math.max(1, Math.min(4, Math.floor(window.innerWidth * 0.875 / label.width)));
            const width = label.width * scale;
            frame.style.left = `${Math.floor((window.innerWidth - width) / 2)}px`;
            frame.style.width = `${width}px`;
            frame.style.height = `${label.height * scale}px`;
        };
        this.resize();
        window.addEventListener('resize', this.resize);
        this.overlay = frame;
        this.label = label;
        this.buildImages();
        this.renderedMoveID = null;
        this.update(this.moveID);
    }

    public update(moveID: number): void {
        this.moveID = moveID;
        if (this.overlay === null || this.label === null) return;
        if (this.renderedMoveID === moveID) return;
        this.renderedMoveID = moveID;
        const pokemon = this.speciesID > 0 ? this.archive.PokemonNames[this.speciesID - 1] : undefined;
        const move = moveID > 0 ? this.archive.MoveNames[moveID - 1] : undefined;
        const visible = this.enabled && pokemon !== undefined && move !== undefined;
        this.overlay.style.visibility = visible ? 'visible' : 'hidden';
        if (!visible) return;
        const usedMove = this.archive.UsedMoveTemplate.replace('#25', pokemon).replace('#29', move);
        const resultID = this.archive.MoveResultMessageIDs[moveID] ?? -1;
        const result = resultID >= 0 ? this.archive.BattleMessages[resultID] : undefined;
        this.draw(result === undefined ? usedMove : `${usedMove}\n${result}`);
    }

    private draw(text: string): void {
        if (this.label === null) return;
        const ctx = this.label.getContext('2d');
        if (ctx === null) return;
        const font = this.archive.Font;
        const glyphWidth = (character: string): number => {
            const code = character === '♀' ? 0xBE : character === '♂' ? 0xA9 : character.charCodeAt(0);
            const mapIndex = code >= 0x20 && code < 0x80 ? code - 0x20 : code >= 0xA0 && code < 0x100 ? code - 0x40 : 0;
            return font.Widths[font.CharacterMap[mapIndex] ?? 0] - 1;
        };
        const lines: string[] = [];
        for (const paragraph of text.split('\n')) {
            let line = '';
            for (const word of paragraph.split(' ')) {
                const candidate = line.length === 0 ? word : `${line} ${word}`;
                const width = [...candidate].reduce((sum, character) => sum + glyphWidth(character), 0);
                if (line.length !== 0 && width > 212) { lines.push(line); line = word; }
                else line = candidate;
            }
            lines.push(line);
        }
        const height = 13 + lines.length * font.GlyphHeight;
        if (this.label.height !== height) {
            this.label.height = height;
            this.resize?.();
        }
        ctx.clearRect(0, 0, 224, height);
        ctx.fillStyle = 'rgba(0, 0, 139, 0.5882352941)';
        ctx.fillRect(2, 1, 220, height - 5);
        ctx.imageSmoothingEnabled = false;

        const bottom = height - 10;
        ctx.drawImage(this.tileImages[0], 2, 0); ctx.drawImage(this.tileImages[1], 2, bottom);
        ctx.drawImage(this.tileImages[2], 216, 0); ctx.drawImage(this.tileImages[3], 216, bottom);
        for (let y = 5; y < bottom; y += 8) {
            ctx.drawImage(this.tileImages[4], 216, y); ctx.drawImage(this.tileImages[5], 2, y);
        }
        for (let x = 5; x <= 213; x += 8) {
            ctx.drawImage(this.tileImages[6], x, 0); ctx.drawImage(this.tileImages[7], x, bottom);
        }

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            let x = 5;
            for (const character of lines[lineIndex]) {
                const code = character === '♀' ? 0xBE : character === '♂' ? 0xA9 : character.charCodeAt(0);
                const mapIndex = code >= 0x20 && code < 0x80 ? code - 0x20 : code >= 0xA0 && code < 0x100 ? code - 0x40 : 0;
                const glyph = font.CharacterMap[mapIndex] ?? 0;
                ctx.drawImage(this.glyphImages[glyph], x, 4 + lineIndex * font.GlyphHeight);
                x += font.Widths[glyph] - 1;
            }
        }
    }

    private makeImage(width: number, height: number, pixels: Uint8ClampedArray): HTMLCanvasElement {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        const image = ctx.createImageData(width, height);
        image.data.set(pixels);
        ctx.putImageData(image, 0, 0);
        return canvas;
    }

    private buildImages(): void {
        this.tileImages = this.archive.BorderTiles.map((tile) => {
            const src = tile.createTypedArray(Uint8Array);
            const pixels = new Uint8ClampedArray(8 * 8 * 4);
            for (let i = 0; i < 64; i++) {
                const value = (src[i * 2] << 8) | src[i * 2 + 1];
                pixels[i * 4 + 0] = ((value >>> 11) & 0x1F) * 255 / 31;
                pixels[i * 4 + 1] = ((value >>> 6) & 0x1F) * 255 / 31;
                pixels[i * 4 + 2] = ((value >>> 1) & 0x1F) * 255 / 31;
                pixels[i * 4 + 3] = (value & 1) * 255;
            }
            return this.makeImage(8, 8, pixels);
        });
        const font = this.archive.Font;
        const glyphs = font.Glyphs.createTypedArray(Uint8Array);
        this.glyphImages = Array.from({ length: font.Widths.length }, (_, glyph) => {
            const pixels = new Uint8ClampedArray(font.GlyphWidth * font.GlyphHeight * 4);
            const glyphOffset = glyph * font.GlyphWidth * font.GlyphHeight;
            for (let i = 0; i < font.GlyphWidth * font.GlyphHeight; i++) {
                const value = glyphs[glyphOffset + i];
                const intensity = (value >>> 4) * 17;
                pixels[i * 4 + 0] = intensity;
                pixels[i * 4 + 1] = intensity;
                pixels[i * 4 + 2] = intensity;
                pixels[i * 4 + 3] = (value & 0x0F) * 17;
            }
            return this.makeImage(font.GlyphWidth, font.GlyphHeight, pixels);
        });
    }

    public destroy(): void {
        if (this.resize !== null) window.removeEventListener('resize', this.resize);
        this.overlay?.remove();
        this.overlay = null;
        this.label = null;
        this.resize = null;
        this.tileImages = [];
        this.glyphImages = [];
    }
}
