import { decompress } from 'fzstd';
import { mat4 } from 'gl-matrix';
import { CameraController } from '../Camera.js';
import { colorNewFromRGBA } from '../Color.js';
import { makeAttachmentClearDescriptor, makeBackbufferDescSimple } from '../gfx/helpers/RenderGraphHelpers.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { SceneContext } from '../SceneBase.js';
import * as Viewer from '../viewer.js';
import * as UI from '../ui.js';
import { DecodedTexture, parseHiPack, parseTerrainCell, parseTexturePack } from './bin.js';
import { fillSceneParams, makeTerrainPipeline, TerrainGeometry, TerrainTextures } from './render.js';

interface Manifest {
    grid: { width: number; height: number; packSide: number };
    worlds: { name: string; packs: string[] }[];
    textures: { file: string; logicalIdMap: number[] };
}

const pathBase = 'ShadowOfTheColossus';

class SotCRenderer implements Viewer.SceneGfx {
    private helper: GfxRenderHelper;
    private list = new GfxRenderInstList();
    private pipeline: ReturnType<typeof makeTerrainPipeline>;
    private cells = new Map<string, TerrainGeometry[]>();
    private packs = new Map<string, ReturnType<typeof parseHiPack>>();
    private pending = new Set<string>();
    private available: Set<string>;
    private destroyed = false;
    private enableProps = true;
    private renderDistance = 16;

    private textures: TerrainTextures;
    constructor(device: GfxDevice, private context: SceneContext, private manifest: Manifest, decodedTextures: DecodedTexture[]) {
        this.helper = new GfxRenderHelper(device);
        this.pipeline = makeTerrainPipeline(this.helper.renderCache);
        this.textures = new TerrainTextures(device, this.helper.renderCache, decodedTextures);
        this.available = new Set(manifest.worlds[0].packs);
    }

    public adjustCameraController(c: CameraController): void { c.setSceneMoveSpeedMult(1 / 10); }

    public getDefaultWorldMatrix(dst: mat4): void {
        // The 60x60 seamless-stage grid is centered on the world origin.
        // This hook is only used when no ShareData or saved camera is present.
        mat4.targetTo(dst, [0, 100, 180], [0, 0, 0], [0, 1, 0]);
    }

    private updateStreaming(device: GfxDevice, input: Viewer.ViewerRenderInput): void {
        // Terrain positions are absolute. The stage grid runs in reverse from
        // (+2950,+2950), and Z was flipped during vertex decoding.
        const cellX = Math.max(0, Math.min(59, Math.floor((3000 - input.camera.worldMatrix[12]) / 100)));
        const cellY = Math.max(0, Math.min(59, Math.floor((3000 + input.camera.worldMatrix[14]) / 100)));
        const wantedCells = new Set<string>();
        const wantedPacks = new Set<string>();
        const lowRadius = Math.floor(this.renderDistance / 2);
        const highRadius = this.renderDistance - lowRadius;
        for (let y = cellY - lowRadius; y < cellY + highRadius; y++)
            for (let x = cellX - lowRadius; x < cellX + highRadius; x++) {
                if (x < 0 || y < 0 || x >= this.manifest.grid.width || y >= this.manifest.grid.height) continue;
                wantedCells.add(`${x},${y}`);
                const p = `hi/${Math.floor(y / 4).toString().padStart(2, '0')}-${Math.floor(x / 4).toString().padStart(2, '0')}.bin`;
                if (this.available.has(p)) wantedPacks.add(p);
            }
        for (const path of wantedPacks) {
            if (this.packs.has(path) || this.pending.has(path)) continue;
            this.pending.add(path);
            console.log(`[SotC] requesting terrain pack ${path}`);
            this.context.dataFetcher.fetchData(`${pathBase}/${path}`).then((file) => {
                this.pending.delete(path);
                if (this.destroyed) return;
                const entries = parseHiPack(file, path, decompress);
                this.packs.set(path, entries);
            }).catch((error) => {
                this.pending.delete(path);
                console.error(`[SotC] failed to load terrain pack ${path}`, error);
            });
        }
        for (const path of this.packs.keys())
            if (!wantedPacks.has(path)) this.packs.delete(path);
        for (const [key, geometries] of this.cells) {
            if (!wantedCells.has(key)) {
                for (const geometry of geometries) geometry.destroy(device);
                this.cells.delete(key);
            }
        }
        for (const entries of this.packs.values()) for (const entry of entries) {
            const key = `${entry.x},${entry.y}`;
            if (wantedCells.has(key) && !this.cells.has(key)) {
                const meshes = parseTerrainCell(entry.data);
                const geometries = meshes.filter((mesh) => mesh.vertices.length !== 0)
                    .map((mesh) => new TerrainGeometry(device, mesh, this.textures));
                // Keep empty results cached while resident as well, otherwise a
                // malformed or genuinely empty cell would be reparsed every frame.
                this.cells.set(key, geometries);
            }
        }
    }

    private prepare(device: GfxDevice, input: Viewer.ViewerRenderInput): void {
        this.updateStreaming(device, input);
        const manager = this.helper.renderInstManager;
        manager.setCurrentList(this.list);
        const template = this.helper.pushTemplateRenderInst();
        fillSceneParams(template, input.camera.clipFromWorldMatrix);
        template.setGfxProgram(this.pipeline.program);
        for (const geometries of this.cells.values())
            for (const geometry of geometries)
                if (this.enableProps || !geometry.isProp)
                    geometry.prepareToRender(manager, this.pipeline.inputLayout, input.camera.frustum);
        manager.popTemplate();
        this.helper.prepareToRender();
    }

    public render(device: GfxDevice, input: Viewer.ViewerRenderInput): void {
        input.camera.setClipPlanes(1, 20000);
        const clear = makeAttachmentClearDescriptor(colorNewFromRGBA(0.48, 0.58, 0.62, 1));
        const builder = this.helper.renderGraph.newGraphBuilder();
        const color = builder.createRenderTargetID(makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, input, clear), 'Main Color');
        const depth = builder.createRenderTargetID(makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, input, clear), 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Terrain');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, color);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, depth);
            pass.exec((renderer) => this.list.drawOnPassRenderer(this.helper.renderCache, renderer));
        });
        this.helper.antialiasingSupport.pushPasses(builder, input, color);
        builder.resolveRenderTargetToExternalTexture(color, input.onscreenTexture);
        this.prepare(device, input);
        builder.execute();
        this.list.reset();
    }

    public destroy(device: GfxDevice): void {
        this.destroyed = true;
        for (const geometries of this.cells.values())
            for (const geometry of geometries) geometry.destroy(device);
        this.textures.destroy(device);
        this.helper.destroy();
    }

    public createPanels(): UI.Panel[] {
        const panel = new UI.Panel();
        panel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        panel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');

        const props = new UI.Checkbox('Enable Props', this.enableProps);
        props.onchanged = () => this.enableProps = props.checked;
        panel.contents.appendChild(props.elem);

        const distance = new UI.Slider('Render Distance', this.renderDistance, 2, 32);
        distance.setRange(2, 32, 2);
        distance.onvalue = () => {
            this.renderDistance = distance.getValue();
        };
        panel.contents.appendChild(distance.elem);
        return [panel];
    }
}

class SotCSceneDesc implements Viewer.SceneDesc {
    public id = 'world';
    public name = 'World';
    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const manifestData = await context.dataFetcher.fetchData(`${pathBase}/manifest.json`);
        const manifest = JSON.parse(new TextDecoder().decode(manifestData.createTypedArray(Uint8Array))) as Manifest;
        const textureData = await context.dataFetcher.fetchData(`${pathBase}/${manifest.textures.file}`);
        const physicalSheetCount = Math.max(
            ...manifest.textures.logicalIdMap.map((index) => index & 0x7FFF),
        ) + 1;
        return new SotCRenderer(
            device, context, manifest,
            parseTexturePack(textureData, physicalSheetCount, decompress),
        );
    }
}

export const sceneGroup: Viewer.SceneGroup = {
    id: 'sotc',
    name: 'Shadow of the Colossus',
    sceneDescs: [new SotCSceneDesc()],
};
