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
import { DecodedTexture, parseHiPack, parseNto2Textures, parseStageBundle, parseTerrainCell, parseTexturePack, placeStageBundle, type StageBundleDiagnostics, TerrainMesh } from './bin.js';
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
            slowStages?: number[];
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
            bounds: { min: number[]; max: number[] } | null;
        }[];
        himejiBridge?: unknown;
    }>();
    // Parsed without a cell origin so a stage ID shared by multiple grid cells
    // only needs to be decompressed and parsed once.
    private stageBundles = new Map<number, Promise<{
        meshes: TerrainMesh[];
        textures: DecodedTexture[];
        diagnostics: StageBundleDiagnostics;
    }>>();
    // A missing or malformed stage is terminal for this scene lifetime. Keep
    // it separate from pendingStages so streaming does not fetch it every frame.
    private failedStageBundles = new Set<number>();
    private available: Set<string>;
    private destroyed = false;
    private enableStages = true;
    private enableSlowStages = true;
    private aliveBosses = true;
    // Literal terrain-cell footprint width. The game defaults to a 6x6
    // resident square (2x2 hi center plus a two-cell lo ring); this viewer uses
    // the hi payload at all coordinates in that footprint.
    private renderDistance = 6;
    private warnedMissingStageGrid = false;
    private lastStageCell = '';
    private slowGridCell: [number, number] | null = null;
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
            failedStageBundles: [...this.failedStageBundles].sort((a, b) => a - b),
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
        const stageGrid = this.manifest.stageGrid;
        const fineWidth = stageGrid === undefined ? 0 : stageGrid.coarseWidth * stageGrid.fineSide;
        const fineHeight = stageGrid === undefined ? 0 : stageGrid.coarseHeight * stageGrid.fineSide;
        const fineCellSize = fineWidth === 0 ? 0 : 6000 / fineWidth;
        const stageFX = fineWidth === 0 ? 0 : (3000 - input.camera.worldMatrix[12]) / fineCellSize;
        const stageFY = fineHeight === 0 ? 0 : (3000 - input.camera.worldMatrix[14]) / fineCellSize;
        const stageX = Math.max(0, Math.min(fineWidth - 1, Math.floor(stageFX)));
        const stageY = Math.max(0, Math.min(fineHeight - 1, Math.floor(stageFY)));
        // The stage manager begins transitions before the cell boundary,
        // retaining edge/corner neighbors through its 0.42/0.58 hysteresis.
        const edgeLow = 0.42;
        const edgeHigh = 0.58;
        const fracX = stageFX - Math.floor(stageFX), fracY = stageFY - Math.floor(stageFY);
        const xNeighbor = fracX < edgeLow ? -1 : fracX > edgeHigh ? 1 : 0;
        const yNeighbor = fracY < edgeLow ? -1 : fracY > edgeHigh ? 1 : 0;
        // SlowCellSelectionUpdate uses a separate grid whose cells span two
        // 150-unit stage-context cells. It retains the previous coarse cell
        // only within 20 world units of a boundary.
        const slowFineSpan = 2;
        const slowCellSize = fineCellSize * slowFineSpan;
        const slowWorldX = stageFX * fineCellSize;
        const slowWorldY = stageFY * fineCellSize;
        let slowX = Math.floor(slowWorldX / slowCellSize);
        let slowY = Math.floor(slowWorldY / slowCellSize);
        if (this.slowGridCell !== null) {
            const remX = slowWorldX - slowX * slowCellSize;
            const remY = slowWorldY - slowY * slowCellSize;
            if (slowX < this.slowGridCell[0] && remX > slowCellSize - 20) slowX++;
            else if (this.slowGridCell[0] < slowX && remX < 20) slowX--;
            if (slowY < this.slowGridCell[1] && remY > slowCellSize - 20) slowY++;
            else if (this.slowGridCell[1] < slowY && remY < 20) slowY--;
        }
        const slowGridWidth = Math.ceil(fineWidth / slowFineSpan);
        const slowGridHeight = Math.ceil(fineHeight / slowFineSpan);
        this.slowGridCell = [
            Math.max(0, Math.min(slowGridWidth - 1, slowX)),
            Math.max(0, Math.min(slowGridHeight - 1, slowY)),
        ];
        const slowStageCell: [number, number] = [
            this.slowGridCell[0] * slowFineSpan,
            this.slowGridCell[1] * slowFineSpan,
        ];
        const selectedStageCells: [number, number][] = [[stageX, stageY]];
        if (xNeighbor !== 0) selectedStageCells.push([stageX + xNeighbor, stageY]);
        if (yNeighbor !== 0) selectedStageCells.push([stageX, stageY + yNeighbor]);
        if (xNeighbor !== 0 && yNeighbor !== 0)
            selectedStageCells.push([stageX + xNeighbor, stageY + yNeighbor]);
        const ordinaryStageCells = new Set(selectedStageCells.map(([x, y]) => `${x},${y}`));
        if (!ordinaryStageCells.has(`${slowStageCell[0]},${slowStageCell[1]}`))
            selectedStageCells.push(slowStageCell);
        const wantedCells = new Set<string>();
        const wantedPacks = new Set<string>();
        // The game defaults to highRadius=1 and middleRadius=2: an inner 2x2
        // hi square plus a lo ring making a 6x6 resident footprint. We retain
        // those exact coordinates but deliberately use each coordinate's hi
        // payload throughout. The slider overrides the combined footprint size
        // without affecting the independent stage-cell set.
        const terrainDistance = this.renderDistance;
        const lowRadius = Math.floor(terrainDistance / 2);
        const highRadius = terrainDistance - lowRadius;
        for (let y = cellY - lowRadius; y < cellY + highRadius; y++)
            for (let x = cellX - lowRadius; x < cellX + highRadius; x++) {
                if (x < 0 || y < 0 || x >= this.manifest.grid.width || y >= this.manifest.grid.height) continue;
                wantedCells.add(`${x},${y}`);
            }
        for (const key of wantedCells) {
                const [x, y] = key.split(',').map(Number);
                if (x < 0 || y < 0 || x >= this.manifest.grid.width || y >= this.manifest.grid.height) continue;
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
        if (stageGrid === undefined) {
            if (!this.warnedMissingStageGrid) {
                this.warnedMissingStageGrid = true;
                console.warn('[SotC] manifest has no stageGrid; stage-bundle rendering is disabled');
            }
            return;
        }
        // Terrain vertices are reflected on Z while decoding, so its packed
        // cell rows increase with viewer Z. The stage context table remains
        // indexed in the game's original Z direction and therefore uses the
        // opposite sign.
        const includeStageNeighbors = true;
        const wantedStageInstances = new Set<string>();
        const wantedStageIds = new Set<number>();
        const selectedCoarseCells = new Set<string>();
        const stageContributions: {
            fineCell: number[];
            coarseCell: number[];
            coarseStages: number[];
            stages: number[];
            bossStages: number[];
            slowStages: number[];
            combined: number[];
        }[] = [];
        for (const [x, y] of selectedStageCells) {
            if (x < 0 || y < 0 || x >= fineWidth || y >= fineHeight)
                continue;
            const coarseX = Math.floor(x / stageGrid.fineSide);
            const coarseY = Math.floor(y / stageGrid.fineSide);
            const coarseKey = `${coarseX},${coarseY}`;
            const fineCell = stageGrid.fineCells[y * fineWidth + x];
            const ordinarySelected = ordinaryStageCells.has(`${x},${y}`);
            const coarseStages = ordinarySelected
                ? stageGrid.coarseCells[coarseY * stageGrid.coarseWidth + coarseX] ?? [] : [];
            const stages = ordinarySelected ? fineCell?.stages ?? [] : [];
            const bossStages = ordinarySelected
                ? (this.aliveBosses ? fineCell?.aliveBosses ?? [] : fineCell?.deadBosses ?? []) : [];
            // SlowCellSelectionUpdate maintains one independent fine-cell
            // selection. Its +0x34 stage is a fixed world-space backdrop, not
            // an ordinary StageLayout contribution from every neighbor.
            const slowStages = x === slowStageCell[0] && y === slowStageCell[1]
                ? fineCell?.slowStages ?? [] : [];
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
                slowStages,
                combined: [...new Set([...ids, ...slowStages])].sort((a, b) => a - b),
            });
            selectedCoarseCells.add(coarseKey);
            const instances = [
                ...ids.map((id) => ({ id, key: `${coarseKey}:${id}`, slowOnly: false })),
                ...slowStages.map((id) => ({ id, key: `slow:${id}`, slowOnly: true })),
            ];
            for (const { id, key, slowOnly } of instances) {
                wantedStageIds.add(id);
                // References from all four-by-four fine records share the
                // enclosing coarse coordinate frame in initlayout.
                wantedStageInstances.add(key);
                if (this.stageCells.has(key) || this.pendingStages.has(key) || this.failedStageBundles.has(id))
                    continue;
                this.pendingStages.add(key);
                let bundle = this.stageBundles.get(id);
                if (bundle === undefined) {
                    bundle = this.context.dataFetcher.fetchData(`${pathBase}/stage/${id}.bin`)
                        .then((file) => decompress(file.createTypedArray(Uint8Array)))
                        .then((bytes) => {
                            const diagnostics: StageBundleDiagnostics = {};
                            return {
                                meshes: parseStageBundle(
                                    ArrayBufferSlice.fromView(bytes),
                                    id === 382 ? 'stage 382' : '',
                                    diagnostics,
                                ),
                                textures: parseNto2Textures(bytes),
                                diagnostics,
                            };
                        });
                    this.stageBundles.set(id, bundle);
                }
                bundle.then(({ meshes, textures, diagnostics }) => {
                    this.pendingStages.delete(key);
                    if (this.destroyed || !wantedStageInstances.has(key))
                        return;
                    this.textures.addTextures(device, textures);
                    const coarseCellSize = 6000 / stageGrid.coarseWidth;
                    const originX = 3000 - (coarseX + 0.5) * coarseCellSize;
                    const originZ = 3000 - (coarseY + 0.5) * coarseCellSize;
                    const selectedMeshes = slowOnly
                        ? meshes.filter((mesh) => mesh.stagePlacement === 'direct')
                        : meshes;
                    const placedMeshes = placeStageBundle(selectedMeshes, originX, originZ);
                    this.stageCells.set(key, placedMeshes.filter((mesh) => mesh.vertices.length !== 0)
                        .map((mesh) => new TerrainGeometry(device, mesh, this.textures)));
                    const bounds = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
                    const resources = new Map<string, {
                        source: string;
                        meshes: number;
                        triangles: number;
                        bounds: number[];
                    }>();
                    const focusedMeshes: NonNullable<NonNullable<ReturnType<typeof this.stageDebug.get>>['focusedMeshes']> = [];
                    const himejiBridge = id !== 344 ? undefined :
                        (diagnostics.layouts as {
                            target?: string;
                            stageLayout?: unknown;
                            baseLayoutDebug?: unknown;
                            animatedChildren?: unknown[];
                        }[] | undefined)?.filter((layout) => (layout.animatedChildren?.length ?? 0) !== 0)
                            .map(({ target, stageLayout, baseLayoutDebug, animatedChildren }) => ({
                                target, stageLayout, baseLayoutDebug, animatedChildren,
                            }));
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
                            bounds: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity],
                        };
                        resource.meshes++;
                        resource.triangles += triangles;
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
                        himejiBridge,
                        resources: [...resources.values()].map((resource) => ({
                            source: resource.source,
                            meshes: resource.meshes,
                            triangles: resource.triangles,
                            bounds: resource.meshes === 0 ? null : {
                                min: resource.bounds.slice(0, 3),
                                max: resource.bounds.slice(3, 6),
                            },
                        })),
                    });
                }).catch((error) => {
                    this.pendingStages.delete(key);
                    this.stageBundles.delete(id);
                    const firstFailure = !this.failedStageBundles.has(id);
                    this.failedStageBundles.add(id);
                    if (firstFailure)
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
                slowCell: slowStageCell,
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
        for (const [key, geometries] of this.stageCells)
            if (key.startsWith('slow:') ? this.enableSlowStages : this.enableStages)
                for (const geometry of geometries)
                    if (geometry.isLayer1)
                        geometry.prepareToRender(manager, this.pipeline, input.camera.frustum, input.camera.viewMatrix);
        manager.setCurrentList(this.terrainList);
        for (const geometries of this.cells.values())
            for (const geometry of geometries)
                if (!geometry.isLayer1 && !geometry.isSpecialLayer)
                    geometry.prepareToRender(manager, this.pipeline, input.camera.frustum, input.camera.viewMatrix);
        for (const [key, geometries] of this.stageCells)
            if (key.startsWith('slow:') ? this.enableSlowStages : this.enableStages)
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
        // The game draws display layer 1 (sky and SLOWMODEL geometry) with
        // normal depth testing, then bgEnd clears depth before layers 2/5.
        // Separate transient depth targets reproduce that boundary while
        // preserving the layer-1 color buffer.
        const backgroundDepth = builder.createRenderTargetID(makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, input, clear), 'Background Depth');
        const depth = builder.createRenderTargetID(makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, input, clear), 'Main Depth');
        builder.pushPass((pass) => {
            // modelGetDlLayer maps the 0x4086/0x4186 SRFs to layer 1,
            // before ordinary world geometry.
            pass.setDebugName('Display Layer 1');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, color);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, backgroundDepth);
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

        const stages = new UI.Checkbox('Show Stages', this.enableStages);
        stages.onchanged = () => this.enableStages = stages.checked;
        panel.contents.appendChild(stages.elem);

        const slowStages = new UI.Checkbox('Show Slow Stages', this.enableSlowStages);
        slowStages.onchanged = () => this.enableSlowStages = slowStages.checked;
        panel.contents.appendChild(slowStages.elem);

        const bosses = new UI.Checkbox('Alive Bosses', this.aliveBosses);
        bosses.onchanged = () => this.aliveBosses = bosses.checked;
        panel.contents.appendChild(bosses.elem);

        const distance = new UI.Slider('Render Distance', this.renderDistance, 1, 32);
        distance.setRange(1, 32, 1);
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
