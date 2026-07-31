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
import { DecodedTexture, parseHiPack, parseNto2Textures, parseStageBundle, parseTerrainCell, parseTexturePack, placeStageBundle, StageBundleDiagnostics, TerrainMesh } from './bin.js';
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
    private stageDebug = new Map<string, {
        stage: number;
        coarseCell: number[];
        cellOrigin: number[];
        bounds: { min: number[]; max: number[] } | null;
        meshes: number;
        triangles: number;
        focusedMeshes?: {
            mesh: number;
            texture: string | null;
            secondaryTexture: string | null;
            triangles: number;
            bounds: { min: number[]; max: number[] };
            layer1: boolean;
            specialLayer: boolean;
            translucent: boolean;
            water: boolean;
            disableCull: boolean;
            gsAlpha: string;
            gsAlphaFix: number;
        }[];
        resources: {
            source: string;
            meshes: number;
            triangles: number;
            textures: string[];
            bounds: { min: number[]; max: number[] } | null;
        }[];
    }>();
    // Parsed without a cell origin so a stage ID shared by multiple grid cells
    // only needs to be decompressed and parsed once.
    private stageBundles = new Map<number, Promise<{ meshes: TerrainMesh[]; textures: DecodedTexture[] }>>();
    private stageBundleDiagnostics = new Map<number, StageBundleDiagnostics>();
    private available: Set<string>;
    private destroyed = false;
    private enableProps = true;
    private aliveBosses = true;
    private renderDistance = 16;
    private warnedMissingStageGrid = false;
    private lastStageCell = '';
    private streamingDebug: Record<string, unknown> | null = null;

    private onKeyDown = (event: KeyboardEvent): void => {
        if (event.code !== 'KeyY' || event.repeat)
            return;
        const target = event.target;
        if (target instanceof HTMLElement &&
            (target.isContentEditable || target instanceof HTMLInputElement ||
             target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement))
            return;
        const loaded = [...this.stageCells].map(([key, geometries]) => ({
            key,
            ...(this.stageDebug.get(key) ?? {
                coarseCell: key.substring(0, key.lastIndexOf(':')),
                stage: Number(key.substring(key.lastIndexOf(':') + 1)),
                meshes: geometries.length,
            }),
        }));
        console.warn('[SotC] position/stage debug dump (Y)\n' + JSON.stringify({
            ...this.streamingDebug,
            loaded,
            pending: [...this.pendingStages],
            parsedStageBundles: [...this.stageBundles.keys()].sort((a, b) => a - b),
            stage373AssociationTrace: this.stageBundleDiagnostics.get(373) ?? null,
            stage378AssociationTrace: this.stageBundleDiagnostics.get(378) ?? null,
        }, (key, value) => {
            if (key === 'bounds' && value !== null &&
                Array.isArray(value.min) && Array.isArray(value.max))
                return `${value.min.map(Math.round).join(',')} ${value.max.map(Math.round).join(',')}`;
            return value;
        }));
    };

    private textures: TerrainTextures;
    constructor(device: GfxDevice, private context: SceneContext, private manifest: Manifest, decodedTextures: DecodedTexture[]) {
        this.helper = new GfxRenderHelper(device);
        this.pipeline = makeTerrainPipeline(this.helper.renderCache);
        this.textures = new TerrainTextures(device, this.helper.renderCache, decodedTextures);
        this.available = new Set(manifest.worlds[0].packs);
        document.addEventListener('keydown', this.onKeyDown);
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
        // The high+middle radius belongs to streamed map/detail data. Stage
        // layouts use the separate current/edge/corner list maintained by the
        // stage manager, with transitions at 0.42 and 0.58 of a fine cell.
        const fracX = stageFX - Math.floor(stageFX), fracY = stageFY - Math.floor(stageFY);
        const xNeighbor = fracX < 0.42 ? -1 : fracX > 0.58 ? 1 : 0;
        const yNeighbor = fracY < 0.42 ? -1 : fracY > 0.58 ? 1 : 0;
        // The viewer's minimum distance is an explicit debugging override:
        // retain only the current fine stage cell. Any higher distance uses
        // the game's ordinary edge/corner activation set.
        const includeStageNeighbors = this.renderDistance > 2;
        const selectedStageCells: [number, number][] = [[stageX, stageY]];
        if (includeStageNeighbors && xNeighbor !== 0) selectedStageCells.push([stageX + xNeighbor, stageY]);
        if (includeStageNeighbors && yNeighbor !== 0) selectedStageCells.push([stageX, stageY + yNeighbor]);
        if (includeStageNeighbors && xNeighbor !== 0 && yNeighbor !== 0)
            selectedStageCells.push([stageX + xNeighbor, stageY + yNeighbor]);
        const wantedStageInstances = new Set<string>();
        const wantedStageIds = new Set<number>();
        const selectedCoarseCells = new Set<string>();
        const stageContributions: {
            fineCell: number[];
            coarseCell: number[];
            coarseStages: number[];
            stages: number[];
            bossStages: number[];
            combined: number[];
        }[] = [];
        for (const [x, y] of selectedStageCells) {
            if (x < 0 || y < 0 || x >= fineWidth || y >= fineHeight)
                continue;
            const coarseX = Math.floor(x / stageGrid.fineSide);
            const coarseY = Math.floor(y / stageGrid.fineSide);
            const coarseKey = `${coarseX},${coarseY}`;
            const fineCell = stageGrid.fineCells[y * fineWidth + x];
            const coarseStages = stageGrid.coarseCells[coarseY * stageGrid.coarseWidth + coarseX] ?? [];
            const stages = fineCell?.stages ?? [];
            const bossStages = this.aliveBosses ? fineCell?.aliveBosses ?? [] : fineCell?.deadBosses ?? [];
            const ids = [
                ...coarseStages,
                ...stages,
                ...bossStages,
            ];
            stageContributions.push({
                fineCell: [x, y],
                coarseCell: [coarseX, coarseY],
                coarseStages,
                stages,
                bossStages,
                combined: [...new Set(ids)].sort((a, b) => a - b),
            });
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
                    const diagnostics: StageBundleDiagnostics = {};
                    if (id === 373 || id === 378)
                        this.stageBundleDiagnostics.set(id, diagnostics);
                    bundle = this.context.dataFetcher.fetchData(`${pathBase}/stage/${id}.bin`)
                        .then((file) => decompress(file.createTypedArray(Uint8Array)))
                        .then((bytes) => ({
                            meshes: parseStageBundle(
                                ArrayBufferSlice.fromView(bytes),
                                id === 382 ? 'stage 382' : '',
                                id === 373 || id === 378 ? diagnostics : undefined,
                            ),
                            textures: parseNto2Textures(bytes),
                        }));
                    this.stageBundles.set(id, bundle);
                }
                bundle.then(({ meshes, textures }) => {
                    this.pendingStages.delete(key);
                    if (this.destroyed || !wantedStageInstances.has(key))
                        return;
                    this.textures.addTextures(device, textures);
                    const coarseCellSize = 6000 / stageGrid.coarseWidth;
                    const originX = 3000 - (coarseX + 0.5) * coarseCellSize;
                    const originZ = 3000 - (coarseY + 0.5) * coarseCellSize;
                    const placedMeshes = placeStageBundle(meshes, originX, originZ);
                    this.stageCells.set(key, placedMeshes.filter((mesh) => mesh.vertices.length !== 0)
                        .map((mesh) => new TerrainGeometry(device, mesh, this.textures)));
                    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
                    const resources = new Map<string, {
                        source: string;
                        meshes: number;
                        triangles: number;
                        textures: Set<string>;
                        bounds: number[];
                    }>();
                    const focusedMeshes: NonNullable<NonNullable<ReturnType<typeof this.stageDebug.get>>['focusedMeshes']> = [];
                    let meshCount = 0, triangleCount = 0;
                    for (let meshIndex = 0; meshIndex < placedMeshes.length; meshIndex++) {
                        const mesh = placedMeshes[meshIndex];
                        if (mesh.vertices.length === 0) continue;
                        meshCount++;
                        const triangles = mesh.vertices.length / 14 / 3;
                        triangleCount += triangles;
                        const resource = resources.get(mesh.sourceName) ?? {
                            source: mesh.sourceName,
                            meshes: 0,
                            triangles: 0,
                            textures: new Set<string>(),
                            bounds: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
                        };
                        resource.meshes++;
                        resource.triangles += triangles;
                        if (mesh.textureName !== null) resource.textures.add(mesh.textureName);
                        if (mesh.secondaryTextureName !== null) resource.textures.add(mesh.secondaryTextureName);
                        resources.set(mesh.sourceName, resource);
                        const meshBounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
                        for (let i = 0; i < mesh.vertices.length; i += 14) {
                            for (let axis = 0; axis < 3; axis++) {
                                const value = mesh.vertices[i + axis];
                                bounds[axis] = Math.min(bounds[axis], value);
                                bounds[axis + 3] = Math.max(bounds[axis + 3], value);
                                resource.bounds[axis] = Math.min(resource.bounds[axis], value);
                                resource.bounds[axis + 3] = Math.max(resource.bounds[axis + 3], value);
                                meshBounds[axis] = Math.min(meshBounds[axis], value);
                                meshBounds[axis + 3] = Math.max(meshBounds[axis + 3], value);
                            }
                        }
                        if (id === 378 && mesh.sourceName === 'nmo/home_spiral_stair.nmo') {
                            focusedMeshes.push({
                                mesh: meshIndex,
                                texture: mesh.textureName,
                                secondaryTexture: mesh.secondaryTextureName,
                                triangles,
                                bounds: { min: meshBounds.slice(0, 3), max: meshBounds.slice(3, 6) },
                                layer1: mesh.isLayer1,
                                specialLayer: mesh.isSpecialLayer,
                                translucent: mesh.isTranslucent,
                                water: mesh.isWater,
                                disableCull: mesh.disableCull,
                                gsAlpha: `0x${mesh.gsAlpha.toString(16).padStart(8, '0')}`,
                                gsAlphaFix: mesh.gsAlphaFix,
                            });
                        }
                    }
                    this.stageDebug.set(key, {
                        stage: id,
                        coarseCell: [coarseX, coarseY],
                        cellOrigin: [originX, 0, originZ],
                        bounds: meshCount === 0 ? null : {
                            min: bounds.slice(0, 3),
                            max: bounds.slice(3, 6),
                        },
                        meshes: meshCount,
                        triangles: triangleCount,
                        focusedMeshes: focusedMeshes.length === 0 ? undefined : focusedMeshes,
                        resources: [...resources.values()].map((resource) => ({
                            source: resource.source,
                            meshes: resource.meshes,
                            triangles: resource.triangles,
                            textures: [...resource.textures].sort(),
                            bounds: resource.meshes === 0 ? null : {
                                min: resource.bounds.slice(0, 3),
                                max: resource.bounds.slice(3, 6),
                            },
                        })),
                    });
                }).catch((error) => {
                    this.pendingStages.delete(key);
                    this.stageBundles.delete(id);
                    console.error(`[SotC] failed to load stage bundle ${id}`, error);
                });
            }
        }
        const coarseCellSize = 6000 / stageGrid.coarseWidth;
        this.streamingDebug = {
            camera: {
                x: input.camera.worldMatrix[12],
                y: input.camera.worldMatrix[13],
                z: input.camera.worldMatrix[14],
            },
            terrain: {
                cell: [cellX, cellY],
                pack: `hi/${Math.floor(cellY / 4).toString().padStart(2, '0')}-${Math.floor(cellX / 4).toString().padStart(2, '0')}.bin`,
            },
            stage: {
                renderDistance: this.renderDistance,
                includeNeighbors: includeStageNeighbors,
                floatingCell: [stageFX, stageFY],
                cell: [stageX, stageY],
                enclosingCoarseCell: [
                    Math.floor(stageX / stageGrid.fineSide),
                    Math.floor(stageY / stageGrid.fineSide),
                ],
                selectedFineCells: selectedStageCells,
                selectedCoarseCells: [...selectedCoarseCells],
                bossVariant: this.aliveBosses ? 'alive' : 'dead',
                wantedStageIds: [...wantedStageIds].sort((a, b) => a - b),
                wantedInstances: [...wantedStageInstances].sort(),
                coarseOrigins: [...selectedCoarseCells].map((key) => {
                    const [x, y] = key.split(',').map(Number);
                    return {
                        coarseCell: [x, y],
                        origin: [
                            3000 - (x + 0.5) * coarseCellSize,
                            0,
                            3000 - (y + 0.5) * coarseCellSize,
                        ],
                    };
                }),
                contributions: stageContributions,
            },
        };
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
        }
        for (const [key, geometries] of this.stageCells) {
            if (!wantedStageInstances.has(key)) {
                for (const geometry of geometries) geometry.destroy(device);
                this.stageCells.delete(key);
                this.stageDebug.delete(key);
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
        document.removeEventListener('keydown', this.onKeyDown);
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
