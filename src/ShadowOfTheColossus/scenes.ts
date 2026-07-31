import { decompress } from 'fzstd';
import { mat4 } from 'gl-matrix';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
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
import { DecodedTexture, parseHiPack, parseStageBundle, parseTerrainCell, parseTexturePack, placeStageBundle, TerrainMesh } from './bin.js';
import { fillSceneParams, makeTerrainPipeline, TerrainGeometry, TerrainTextures } from './render.js';

interface Manifest {
    grid: { width: number; height: number; packSide: number };
    worlds: { name: string; packs: string[] }[];
    textures: { file: string; logicalIdMap: number[] };
    stageGrid?: {
        coarseWidth: number;
        coarseHeight: number;
        fineSide: number;
        coarseCells: number[][];
        fineCells: {
            stages: number[];
            aliveBosses: number[];
            deadBosses: number[];
        }[];
    };
}

const pathBase = 'ShadowOfTheColossus';

class SotCRenderer implements Viewer.SceneGfx {
    private helper: GfxRenderHelper;
    private terrainList = new GfxRenderInstList();
    private skyList = new GfxRenderInstList();
    private pipeline: ReturnType<typeof makeTerrainPipeline>;
    private cells = new Map<string, TerrainGeometry[]>();
    // Keep decompressed 4x4 packs for the scene lifetime. GPU geometry still
    // streams below, but revisiting an area must not decompress its 16 cells.
    private packs = new Map<string, ReturnType<typeof parseHiPack>>();
    private pending = new Set<string>();
    private stageCells = new Map<string, TerrainGeometry[]>();
    private pendingStages = new Set<string>();
    // Parsed without a cell origin so a stage ID shared by multiple grid cells
    // only needs to be decompressed and parsed once.
    private stageBundles = new Map<number, Promise<TerrainMesh[]>>();
    private available: Set<string>;
    private destroyed = false;
    private enableProps = true;
    private aliveBosses = true;
    private renderDistance = 16;
    private warnedMissingStageGrid = false;
    private lastStageCell = '';
    private probeCellX = -1;
    private probeCellY = -1;
    private probeWorldX = 0;
    private probeWorldZ = 0;

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

    private meshGroundHits(meshes: TerrainMesh[], worldX: number, worldZ: number) {
        const hits: {
            mesh: number;
            source: string;
            texture: string | null;
            groundY: number;
            translucent: boolean;
            specialLayer: boolean;
            water: boolean;
        }[] = [];
        const nearest: {
            mesh: number;
            source: string;
            texture: string | null;
            triangles: number;
            xzBounds: number[];
            xzDistance: number;
            yRange: number[];
        }[] = [];
        const overallBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        for (let meshIndex = 0; meshIndex < meshes.length; meshIndex++) {
            const mesh = meshes[meshIndex], vertices = mesh.vertices;
            const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
            for (let i = 0; i < vertices.length; i += 14) {
                const x = vertices[i], y = vertices[i + 1], z = vertices[i + 2];
                bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y); bounds[2] = Math.min(bounds[2], z);
                bounds[3] = Math.max(bounds[3], x); bounds[4] = Math.max(bounds[4], y); bounds[5] = Math.max(bounds[5], z);
            }
            if (vertices.length !== 0) {
                for (let i = 0; i < 6; i++)
                    overallBounds[i] = i < 3 ? Math.min(overallBounds[i], bounds[i]) : Math.max(overallBounds[i], bounds[i]);
                const dx = worldX < bounds[0] ? bounds[0] - worldX : worldX > bounds[3] ? worldX - bounds[3] : 0;
                const dz = worldZ < bounds[2] ? bounds[2] - worldZ : worldZ > bounds[5] ? worldZ - bounds[5] : 0;
                nearest.push({
                    mesh: meshIndex,
                    source: mesh.sourceName,
                    texture: mesh.textureName,
                    triangles: vertices.length / 14 / 3,
                    xzBounds: [bounds[0], bounds[2], bounds[3], bounds[5]],
                    xzDistance: Math.hypot(dx, dz),
                    yRange: [bounds[1], bounds[4]],
                });
            }
            for (let i = 0; i + 41 < vertices.length; i += 42) {
                const x0 = vertices[i], y0 = vertices[i + 1], z0 = vertices[i + 2];
                const x1 = vertices[i + 14], y1 = vertices[i + 15], z1 = vertices[i + 16];
                const x2 = vertices[i + 28], y2 = vertices[i + 29], z2 = vertices[i + 30];
                const denominator = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
                if (Math.abs(denominator) < 1e-8) continue;
                const a = ((z1 - z2) * (worldX - x2) + (x2 - x1) * (worldZ - z2)) / denominator;
                const b = ((z2 - z0) * (worldX - x2) + (x0 - x2) * (worldZ - z2)) / denominator;
                const c = 1 - a - b;
                if (a < -1e-5 || b < -1e-5 || c < -1e-5) continue;
                hits.push({
                    mesh: meshIndex,
                    source: mesh.sourceName,
                    texture: mesh.textureName,
                    groundY: a * y0 + b * y1 + c * y2,
                    translucent: mesh.isTranslucent,
                    specialLayer: mesh.isSpecialLayer,
                    water: mesh.isWater,
                });
            }
        }
        return {
            overallBounds: nearest.length === 0 ? null : {
                min: overallBounds.slice(0, 3),
                max: overallBounds.slice(3, 6),
            },
            hits: hits.sort((a, b) => b.groundY - a.groundY),
            nearest: nearest.sort((a, b) => a.xzDistance - b.xzDistance).slice(0, 12),
        };
    }

    private debugGroundProbe(cellX: number, cellY: number, worldX: number, worldZ: number): void {
        const packPath = `hi/${Math.floor(cellY / 4).toString().padStart(2, '0')}-${Math.floor(cellX / 4).toString().padStart(2, '0')}.bin`;
        const entries = this.packs.get(packPath);
        const entry = entries?.find((v) => v.x === cellX && v.y === cellY);
        if (entries === undefined || entry === undefined) {
            console.warn('[SotC] terrain ground probe unavailable', {
                terrainCell: [cellX, cellY],
                worldXZ: [worldX, worldZ],
                packPath,
                packAvailable: this.available.has(packPath),
                packPending: this.pending.has(packPath),
                packResident: entries !== undefined,
                cellPresentInPack: entry !== undefined,
            });
            return;
        }

        const meshes = parseTerrainCell(entry.data);
        const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
        let triangleCount = 0;
        const hits: {
            mesh: number;
            texture: string | null;
            groundY: number;
            translucent: boolean;
            specialLayer: boolean;
            water: boolean;
            triangle: number[][];
        }[] = [];
        const materials = meshes.map((mesh, meshIndex) => {
            const vertices = mesh.vertices;
            const meshTriangles = vertices.length / 14 / 3;
            triangleCount += meshTriangles;
            for (let i = 0; i < vertices.length; i += 14) {
                bounds[0] = Math.min(bounds[0], vertices[i]);
                bounds[1] = Math.min(bounds[1], vertices[i + 1]);
                bounds[2] = Math.min(bounds[2], vertices[i + 2]);
                bounds[3] = Math.max(bounds[3], vertices[i]);
                bounds[4] = Math.max(bounds[4], vertices[i + 1]);
                bounds[5] = Math.max(bounds[5], vertices[i + 2]);
            }
            for (let i = 0; i + 41 < vertices.length; i += 42) {
                const x0 = vertices[i], y0 = vertices[i + 1], z0 = vertices[i + 2];
                const x1 = vertices[i + 14], y1 = vertices[i + 15], z1 = vertices[i + 16];
                const x2 = vertices[i + 28], y2 = vertices[i + 29], z2 = vertices[i + 30];
                const denominator = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
                if (Math.abs(denominator) < 1e-8) continue;
                const a = ((z1 - z2) * (worldX - x2) + (x2 - x1) * (worldZ - z2)) / denominator;
                const b = ((z2 - z0) * (worldX - x2) + (x0 - x2) * (worldZ - z2)) / denominator;
                const c = 1 - a - b;
                if (a < -1e-5 || b < -1e-5 || c < -1e-5) continue;
                hits.push({
                    mesh: meshIndex,
                    texture: mesh.textureName,
                    groundY: a * y0 + b * y1 + c * y2,
                    translucent: mesh.isTranslucent,
                    specialLayer: mesh.isSpecialLayer,
                    water: mesh.isWater,
                    triangle: [[x0, y0, z0], [x1, y1, z1], [x2, y2, z2]],
                });
            }
            return {
                mesh: meshIndex,
                texture: mesh.textureName,
                triangles: meshTriangles,
                translucent: mesh.isTranslucent,
                specialLayer: mesh.isSpecialLayer,
                layer1: mesh.isLayer1,
                water: mesh.isWater,
            };
        });
        console.warn('[SotC] terrain ground probe', {
            terrainCell: [cellX, cellY],
            worldXZ: [worldX, worldZ],
            packPath,
            meshCount: meshes.length,
            triangleCount,
            bounds: triangleCount === 0 ? null : { min: bounds.slice(0, 3), max: bounds.slice(3, 6) },
            hits: hits.sort((a, b) => b.groundY - a.groundY),
            materials,
        });
    }

    private updateStreaming(device: GfxDevice, input: Viewer.ViewerRenderInput): void {
        // Terrain positions are absolute. The stage grid runs in reverse from
        // (+2950,+2950), and Z was flipped during vertex decoding.
        const cellX = Math.max(0, Math.min(59, Math.floor((3000 - input.camera.worldMatrix[12]) / 100)));
        const cellY = Math.max(0, Math.min(59, Math.floor((3000 + input.camera.worldMatrix[14]) / 100)));
        this.probeCellX = cellX;
        this.probeCellY = cellY;
        this.probeWorldX = input.camera.worldMatrix[12];
        this.probeWorldZ = input.camera.worldMatrix[14];
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
            this.context.dataFetcher.fetchData(`${pathBase}/${path}`).then((file) => {
                this.pending.delete(path);
                if (this.destroyed) return;
                const entries = parseHiPack(file, path, decompress);
                this.packs.set(path, entries);
                const probePack = `hi/${Math.floor(this.probeCellY / 4).toString().padStart(2, '0')}-${Math.floor(this.probeCellX / 4).toString().padStart(2, '0')}.bin`;
                if (path === probePack)
                    this.debugGroundProbe(this.probeCellX, this.probeCellY, this.probeWorldX, this.probeWorldZ);
            }).catch((error) => {
                this.pending.delete(path);
                console.error(`[SotC] failed to load terrain pack ${path}`, error);
            });
        }
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

        // Stage activation uses a 4x4 fine subdivision of each 10x10 coarse
        // world cell. initlayout derives the placement origin from the coarse
        // index; the fine record only selects which stages are active.
        const stageGrid = this.manifest.stageGrid;
        if (stageGrid === undefined) {
            if (!this.warnedMissingStageGrid) {
                this.warnedMissingStageGrid = true;
                console.warn('[SotC] manifest has no stageGrid; stage-bundle rendering is disabled');
            }
            return;
        }
        const fineWidth = stageGrid.coarseWidth * stageGrid.fineSide;
        const fineHeight = stageGrid.coarseHeight * stageGrid.fineSide;
        const fineCellSize = 6000 / fineWidth;
        const stageFX = (3000 - input.camera.worldMatrix[12]) / fineCellSize;
        // Terrain vertices are reflected on Z while decoding, so its packed
        // cell rows increase with viewer Z. The stage context table remains
        // indexed in the game's original Z direction and therefore uses the
        // opposite sign.
        const stageFY = (3000 - input.camera.worldMatrix[14]) / fineCellSize;
        const stageX = Math.max(0, Math.min(fineWidth - 1, Math.floor(stageFX)));
        const stageY = Math.max(0, Math.min(fineHeight - 1, Math.floor(stageFY)));
        // The seamless-stage manager's defaults are one high-detail cell plus
        // two middle-detail cells. SeamlessStageLoadWindowRebuild builds the
        // half-open interval [cell - (high + middle),
        // cell + (high + middle)) on each axis.
        // Its 0.42/0.58 tests only decide when to rebuild this window; they do
        // not restrict residency to the adjacent cells.
        const highModelDistance = 1;
        const middleModelDistance = 2;
        const stageRadius = highModelDistance + middleModelDistance;
        const selectedStageCells: [number, number][] = [];
        for (let y = Math.max(0, stageY - stageRadius); y < Math.min(fineHeight, stageY + stageRadius); y++)
            for (let x = Math.max(0, stageX - stageRadius); x < Math.min(fineWidth, stageX + stageRadius); x++)
                selectedStageCells.push([x, y]);
        const wantedStageInstances = new Set<string>();
        const wantedStageIds = new Set<number>();
        const selectedCoarseCells = new Set<string>();
        for (const [x, y] of selectedStageCells) {
            if (x < 0 || y < 0 || x >= fineWidth || y >= fineHeight)
                continue;
            const coarseX = Math.floor(x / stageGrid.fineSide);
            const coarseY = Math.floor(y / stageGrid.fineSide);
            const coarseKey = `${coarseX},${coarseY}`;
            const fineCell = stageGrid.fineCells[y * fineWidth + x];
            const ids = [
                ...(stageGrid.coarseCells[coarseY * stageGrid.coarseWidth + coarseX] ?? []),
                ...(fineCell?.stages ?? []),
                ...(this.aliveBosses ? fineCell?.aliveBosses ?? [] : fineCell?.deadBosses ?? []),
            ];
            selectedCoarseCells.add(coarseKey);
            for (const id of ids) {
                wantedStageIds.add(id);
                // References from all four-by-four fine records share the
                // enclosing coarse coordinate frame in initlayout.
                const key = `${coarseKey}:${id}`;
                wantedStageInstances.add(key);
                if (this.stageCells.has(key) || this.pendingStages.has(key))
                    continue;
                this.pendingStages.add(key);
                let bundle = this.stageBundles.get(id);
                if (bundle === undefined) {
                    bundle = this.context.dataFetcher.fetchData(`${pathBase}/stage/${id}.bin`)
                        .then((file) => ArrayBufferSlice.fromView(decompress(file.createTypedArray(Uint8Array))))
                        .then((unpacked) => parseStageBundle(unpacked, id === 382 ? 'stage 382' : ''));
                    this.stageBundles.set(id, bundle);
                }
                bundle.then((meshes) => {
                    this.pendingStages.delete(key);
                    if (this.destroyed || !wantedStageInstances.has(key))
                        return;
                    const coarseCellSize = 6000 / stageGrid.coarseWidth;
                    const originX = 3000 - (coarseX + 0.5) * coarseCellSize;
                    const originZ = 3000 - (coarseY + 0.5) * coarseCellSize;
                    const placedMeshes = placeStageBundle(meshes, originX, originZ);
                    this.stageCells.set(key, placedMeshes.filter((mesh) => mesh.vertices.length !== 0)
                        .map((mesh) => new TerrainGeometry(device, mesh, this.textures)));
                    const groundProbe = this.meshGroundHits(
                        placedMeshes, this.probeWorldX, this.probeWorldZ,
                    );
                    console.warn('[SotC] stage instance loaded', {
                        stage: id,
                        coarseCell: [coarseX, coarseY],
                        cellOrigin: [originX, 0, originZ],
                        parsedMeshes: meshes.length,
                        placedMeshes: placedMeshes.filter((mesh) => mesh.vertices.length !== 0).length,
                        triangles: placedMeshes.reduce((sum, mesh) => sum + mesh.vertices.length / 14 / 3, 0),
                        placedBounds: groundProbe.overallBounds,
                        probeWorldXZ: [this.probeWorldX, this.probeWorldZ],
                        groundProbe,
                    });
                }).catch((error) => {
                    this.pendingStages.delete(key);
                    this.stageBundles.delete(id);
                    console.error(`[SotC] failed to load stage bundle ${id}`, error);
                });
            }
        }
        const stageCellKey = `${stageX},${stageY}`;
        if (stageCellKey !== this.lastStageCell) {
            this.lastStageCell = stageCellKey;
            const loadedStageIds = new Set<number>();
            for (const key of this.stageCells.keys())
                loadedStageIds.add(Number(key.substring(key.lastIndexOf(':') + 1)));
            console.log(
                `[SotC] stage cell=${stageCellKey} ` +
                `selected=[${selectedStageCells.map(([x, y]) => `${x},${y}`).join(' ')}] ` +
                `coarse=[${[...selectedCoarseCells].join(' ')}] ` +
                `bosses=${this.aliveBosses ? 'alive' : 'dead'} ` +
                `stages=[${[...wantedStageIds].sort((a, b) => a - b).join(' ')}] ` +
                `loaded=[${[...loadedStageIds].sort((a, b) => a - b).join(' ')}] ` +
                `pending=${this.pendingStages.size}`,
            );
            this.debugGroundProbe(
                cellX, cellY,
                input.camera.worldMatrix[12],
                input.camera.worldMatrix[14],
            );
        }
        for (const [key, geometries] of this.stageCells) {
            if (!wantedStageInstances.has(key)) {
                for (const geometry of geometries) geometry.destroy(device);
                this.stageCells.delete(key);
            }
        }
    }

    private prepare(device: GfxDevice, input: Viewer.ViewerRenderInput): void {
        this.updateStreaming(device, input);
        const manager = this.helper.renderInstManager;
        const template = this.helper.pushTemplateRenderInst();
        fillSceneParams(template, input.camera.clipFromWorldMatrix, input.backbufferWidth, input.backbufferHeight, input.time);
        // modelGetDlLayer assigns these SRFs to layer 1. Preserve the game's
        // layer ordering independently of model/resource names.
        manager.setCurrentList(this.skyList);
        for (const geometries of this.cells.values())
            for (const geometry of geometries)
                if (geometry.isLayer1)
                    geometry.prepareToRender(manager, this.pipeline, input.camera.frustum, input.camera.viewMatrix);
        for (const geometries of this.stageCells.values()) {
            for (const geometry of geometries)
                if (geometry.isLayer1)
                    geometry.prepareToRender(manager, this.pipeline, input.camera.frustum, input.camera.viewMatrix);
        }
        manager.setCurrentList(this.terrainList);
        for (const geometries of this.cells.values())
            for (const geometry of geometries)
                if (!geometry.isLayer1 && !geometry.isSpecialLayer)
                    geometry.prepareToRender(manager, this.pipeline, input.camera.frustum, input.camera.viewMatrix);
        if (this.enableProps)
            for (const geometries of this.stageCells.values())
                for (const geometry of geometries)
                    if (!geometry.isLayer1 && !geometry.isSpecialLayer)
                        geometry.prepareToRender(manager, this.pipeline, input.camera.frustum, input.camera.viewMatrix);
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
            // modelGetDlLayer maps the 0x4106/0x4186 SRFs to layer 1,
            // before ordinary world geometry.
            pass.setDebugName('Display Layer 1');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, color);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, depth);
            pass.exec((renderer) => this.skyList.drawOnPassRenderer(this.helper.renderCache, renderer));
        });
        builder.pushPass((pass) => {
            pass.setDebugName('Terrain Opaque');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, color);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, depth);
            pass.exec((renderer) => this.terrainList.drawOnPassRenderer(this.helper.renderCache, renderer));
        });
        this.helper.antialiasingSupport.pushPasses(builder, input, color);
        builder.resolveRenderTargetToExternalTexture(color, input.onscreenTexture);
        this.prepare(device, input);
        builder.execute();
        this.skyList.reset();
        this.terrainList.reset();
    }

    public destroy(device: GfxDevice): void {
        this.destroyed = true;
        for (const geometries of this.cells.values())
            for (const geometry of geometries) geometry.destroy(device);
        for (const geometries of this.stageCells.values())
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

        const bosses = new UI.Checkbox('Alive Bosses', this.aliveBosses);
        bosses.onchanged = () => this.aliveBosses = bosses.checked;
        panel.contents.appendChild(bosses.elem);

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
