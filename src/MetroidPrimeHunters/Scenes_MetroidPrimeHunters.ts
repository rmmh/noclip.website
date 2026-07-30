
// Metroid Prime: Hunters

import * as Viewer from '../viewer.js';
import * as CX from '../Common/Compression/CX.js';
import * as ARC from './mph_arc.js';
import * as UI from '../ui.js';
import { parseMPH_Model, parseTEX0Texture } from './mph_binModel.js';
import { parseMPHAnimation } from './mph_anim.js';
import { findAreaMetadata, MPHAreaMetadata, MPHMetadata, sceneIdToModelStem } from './area_metadata.js';
import { MPHEntityFile, parseMPHEntities } from './entity.js';
import { parseMPHCollision } from './mph_collision.js';
import { findExteriorNodes, MPHStitchedExteriorRoom, MPHStitchController, StitchedSceneDesc } from './stitch.js';

import { DataFetcher } from '../DataFetcher.js';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { MPHFogConfig, MPHLighting, MPHRenderer, MPHRendererOptions, MPHSceneMode } from './render.js';
import { assert, assertExists } from '../util.js';
import { makeBackbufferDescSimple, opaqueBlackFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { FakeTextureHolder } from '../TextureHolder.js';
import { SceneContext } from '../SceneBase.js';
import { CameraController } from '../Camera.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { colorNewFromRGBA } from '../Color.js';
import { mat4, vec3 } from 'gl-matrix';

const pathBase = `MetroidPrimeHunters`;

export class ModelCache {
    private filePromiseCache = new Map<string, Promise<ArrayBufferSlice>>();
    private arcPromiseCache = new Map<string, Promise<void>>();
    private fileDataCache = new Map<string, ArrayBufferSlice>();

    constructor(private dataFetcher: DataFetcher) {
    }

    public async waitForLoad(): Promise<void> {
        await Promise.all([...this.filePromiseCache.values(), ...this.arcPromiseCache.values()]);
    }

    private mountARC(arc: ARC.SNDFILE): void {
        for (let i = 0; i < arc.files.length; i++) {
            const file = arc.files[i];
            this.setFileData(assertExists(file.path), file.buffer);
        }
    }

    private setFileData(path: string, buffer: ArrayBufferSlice): void {
        this.fileDataCache.set(path.toLowerCase(), buffer);
    }

    public fetchFile(path: string): Promise<ArrayBufferSlice> {
        path = path.toLowerCase();
        const existingPromise = this.filePromiseCache.get(path);
        if (existingPromise !== undefined)
            return existingPromise;
        const p = this.dataFetcher.fetchData(`${pathBase}/${path}`);
        this.filePromiseCache.set(path, p);
        return p;
    }

    public fetchMPHARC(path: string): Promise<void> {
        const existingPromise = this.arcPromiseCache.get(path);
        if (existingPromise !== undefined)
            return existingPromise;
        const p = this.fetchFile(path).then((fileData) => {
            this.mountARC(ARC.parse(CX.decompress(fileData)));
        });
        this.arcPromiseCache.set(path, p);
        return p;
    }

    public async fetchMPFile(path: string): Promise<void> {
        this.setFileData(path, await this.fetchFile(path));
    }

    public async fetchJSON<T>(path: string): Promise<T> {
        const data = await this.fetchFile(path);
        return JSON.parse(new TextDecoder().decode(data.createTypedArray(Uint8Array))) as T;
    }

    public getFileData(path: string): ArrayBufferSlice | null {
        return this.fileDataCache.get(path.toLowerCase()) ?? null;
    }
}

export class MPHSceneRenderer implements Viewer.SceneGfx {
    private renderHelper: GfxRenderHelper;
    private renderInstListMain = new GfxRenderInstList();

    public stageRenderers: MPHRenderer[] = [];
    public objectRenderers: MPHRenderer[] = [];
    public entities: MPHEntityFile[] = [];
    public stitch = new MPHStitchController();
    public modelCache: ModelCache;
    public metadata!: MPHMetadata;

    constructor(device: GfxDevice, dataFetcher: DataFetcher) {
        this.renderHelper = new GfxRenderHelper(device);
        this.modelCache = new ModelCache(dataFetcher);
    }

    public async fetchMetadata(): Promise<void> {
        this.metadata = await this.modelCache.fetchJSON<MPHMetadata>('metadata.json');
    }

    public getCache(): GfxRenderCache {
        return this.renderHelper.renderCache;
    }

    public adjustCameraController(c: CameraController) {
        c.setSceneMoveSpeedMult(0.5/60);
    }

    public createPanels(): UI.Panel[] {
        const panel = new UI.Panel();
        panel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        panel.setTitle(UI.RENDER_HACKS_ICON, 'Render Hacks');

        const fog = new UI.Checkbox('Area Fog', true);
        fog.onchanged = () => {
            for (const renderer of [...this.stageRenderers, ...this.objectRenderers])
                renderer.setFogEnabled(fog.checked);
        };
        panel.contents.appendChild(fog.elem);

        return [panel];
    }

    private prepareToRender(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): void {
        viewerInput.camera.setClipPlanes(0.1);
        this.renderHelper.pushTemplateRenderInst();
        const renderInstManager = this.renderHelper.renderInstManager;
        renderInstManager.setCurrentList(this.renderInstListMain);
        this.stitch.prepareToRender(viewerInput);
        for (const stageRenderer of this.stageRenderers)
            stageRenderer.prepareToRender(renderInstManager, viewerInput);
        for (const entities of this.entities)
            entities.update(viewerInput.time);
        for (let i = 0; i < this.objectRenderers.length; i++)
            this.objectRenderers[i].prepareToRender(renderInstManager, viewerInput);
        renderInstManager.popTemplate();

        this.renderHelper.prepareToRender();
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const renderInstManager = this.renderHelper.renderInstManager;

        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, opaqueBlackFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, opaqueBlackFullClearRenderPassDescriptor);

        const builder = this.renderHelper.renderGraph.newGraphBuilder();

        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => {
                this.renderInstListMain.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer);
            });
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);

        this.prepareToRender(device, viewerInput);
        builder.execute();
        this.renderInstListMain.reset();
    }

    public destroy(device: GfxDevice) {
        this.renderHelper.destroy();

        for (const stageRenderer of this.stageRenderers)
            stageRenderer.destroy(device);
        for (let i = 0; i < this.objectRenderers.length; i++)
            this.objectRenderers[i].destroy(device);
    }
}

const standaloneEntityFiles = new Map<string, string>([
    ['cylinderroom_model', 'Unit1_b2_Ent.bin'],
    ['mp_fh_data/levels/models/blueRoom_Model', 'regulator_Ent.bin'],
    ['mp_fh_data/levels/models/e3Level_Model', 'morphBall_Ent.bin'],
    ['mp_fh_data/levels/models/mp1_Model', 'mp1_Ent.bin'],
    ['mp_fh_data/levels/models/mp2_Model', 'survivor_Ent.bin'],
    ['mp_fh_data/levels/models/mp3_Model', 'mp3_Ent.bin'],
    ['mp_fh_data/levels/models/mp5_Model', 'mp5_Ent.bin'],
    ['mp_fh_data/levels/models/testLevel_Model', 'testlevel_Ent.bin'],
]);

export interface MPHAddToSceneOptions {
    sceneTransform: mat4;
    splitExterior?: boolean;
    renderEntities?: boolean;
}

export interface MPHAddedScene {
    renderers: MPHRenderer[];
    doorRenderers: Map<number, MPHRenderer>;
    visibilityRoom: MPHStitchedExteriorRoom | null;
}

export class SceneDesc implements Viewer.SceneDesc {
    constructor(
        public id: string,
        public name: string,
        public sceneMode: MPHSceneMode = { kind: 'singlePlayer', geometrySet: 1 },
        private areaOverride: MPHAreaMetadata | null = null,
        public modelId: string = sceneIdToModelStem(id),
        private archiveOverride: string | null = null,
    ) {
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const renderer = new MPHSceneRenderer(device, context.dataFetcher);
        await renderer.fetchMetadata();
        await this.addToScene(device, renderer, { sceneTransform: mat4.create() });
        return renderer;
    }

    public async addToScene(device: GfxDevice, renderer: MPHSceneRenderer, options: MPHAddToSceneOptions): Promise<MPHAddedScene> {
        const { sceneTransform } = options;
        const splitExterior = options.splitExterior ?? false;
        const renderEntities = options.renderEntities ?? true;
        const modelCache = renderer.modelCache;
        const { areas, entities: entityMetadata, archiveTextures, modelArchives } = renderer.metadata;
        const modelId = this.modelId;
        const area = this.areaOverride ?? (this.id.startsWith('mp_fh_data/') ? null :
            findAreaMetadata(areas, modelId, this.sceneMode.kind === 'multiplayer'));
        const sceneMode: MPHSceneMode = this.sceneMode.kind === 'singlePlayer' && area !== null ?
            { kind: 'singlePlayer', geometrySet: area.geometrySet ?? 1 } : this.sceneMode;
        const modelFilename = area?.modelFilename ?? `${modelId}.bin`;
        const archiveName = this.archiveOverride ?? modelArchives[modelFilename.toLowerCase()] ?? null;
        const textureFilename = archiveName !== null ? archiveTextures[archiveName] ?? null : null;
        const animationFilename = area?.animationFilename ?? `${modelId.replace(/_model$/, '_anim')}.bin`;
        const entityFilename = renderEntities ?
            area?.entityFilename ?? standaloneEntityFiles.get(this.id) ?? null : null;

        if (archiveName !== null) {
            modelCache.fetchMPHARC(`archives/${archiveName}.arc`);
            if (textureFilename !== null)
                modelCache.fetchMPFile(`levels/textures/${textureFilename}`);
        } else {
            modelCache.fetchMPFile(modelFilename);
        }
        if (entityFilename !== null)
            modelCache.fetchMPFile(`levels/entities/${entityFilename}`);
        await modelCache.waitForLoad();

        const bin_Model = modelCache.getFileData(modelFilename);
        const stageBin = parseMPH_Model(assertExists(bin_Model));
        const entityLayerId = sceneMode.kind === 'multiplayer' && sceneMode.captureTheFlag === true ? 12 : 0;
        const entityFile = entityFilename !== null ? assertExists(modelCache.getFileData(`levels/entities/${entityFilename}`)) : null;
        const entities = entityFile !== null ? new MPHEntityFile(
            parseMPHEntities(entityFile, entityLayerId), entityMetadata, modelCache, sceneMode, assertExists(entityFilename)) : null;
        if (entities !== null) {
            entities.requestResources();
            await modelCache.waitForLoad();
        }

        const lighting: MPHLighting = area !== null ? {
            colors: [
                [area.lightColor0[0] / 31, area.lightColor0[1] / 31, area.lightColor0[2] / 31],
                [area.lightColor1[0] / 31, area.lightColor1[1] / 31, area.lightColor1[2] / 31],
            ],
            directions: [
                [-area.lightVector0[0] / 0x1000, -area.lightVector0[1] / 0x1000, -area.lightVector0[2] / 0x1000],
                [-area.lightVector1[0] / 0x1000, -area.lightVector1[1] / 0x1000, -area.lightVector1[2] / 0x1000],
            ],
        } : {
            colors: [[1, 1, 1], [1, 1, 1]],
            directions: [
                [-0.099853515625, 1, 0],
                [0, -0.999755859375, 0.099853515625],
            ],
        };
        const fog: MPHFogConfig | null = area !== null && area.fog.enabled ? {
            color: colorNewFromRGBA(
                (area.fog.color & 0x1F) / 31,
                ((area.fog.color >>> 5) & 0x1F) / 31,
                ((area.fog.color >>> 10) & 0x1F) / 31,
                1,
            ),
            offset: area.fog.offset,
            depthShift: area.fog.depthShift,
            densityTable: Array.from({ length: 32 }, (_, i) => i * 4),
            depthMode: 'w',
            near: 1,
            far: 400,
        } : null;

        const textureFile = textureFilename !== null ? modelCache.getFileData(`levels/textures/${textureFilename}`) : null;
        const stageTex = textureFile !== null ? parseTEX0Texture(textureFile, stageBin.mphTex) : parseTEX0Texture(assertExists(bin_Model), stageBin.mphTex);
        const animationFile = modelCache.getFileData(animationFilename);
        const animation = animationFile !== null ? parseMPHAnimation(animationFile) : null;
        const collisionFile = area !== null ? modelCache.getFileData(area.collisionFilename) : null;
        const collision = collisionFile !== null ? parseMPHCollision(collisionFile) : null;
        const stageOptions: MPHRendererOptions = { sceneMode, fog, collision, sceneTransform };
        const stageTexture = stageBin.tex0 !== null ? stageBin.tex0 : assertExists(stageTex);
        const exteriorNodes = splitExterior ? findExteriorNodes(stageBin, collision) : null;
        const stageRenderer = new MPHRenderer(device, renderer.getCache(), stageBin, stageTexture, animation, {
            ...stageOptions,
            nodeFilter: exteriorNodes !== null ? (name) => !exteriorNodes.has(name) : undefined,
        });
        renderer.stageRenderers.push(stageRenderer);
        const addedRenderers = [stageRenderer];

        // Backdrop geometry stays visible from neighbouring rooms, so it is split
        // into its own renderer that the stitch controller can keep drawing.
        let visibilityRoom: MPHStitchedExteriorRoom | null = null;
        if (exteriorNodes !== null) {
            const exteriorRenderer = new MPHRenderer(device, renderer.getCache(), stageBin, stageTexture, animation, {
                ...stageOptions,
                nodeFilter: (name) => exteriorNodes.has(name),
            });
            renderer.stageRenderers.push(exteriorRenderer);
            addedRenderers.push(exteriorRenderer);
            if (collision !== null) {
                const inverseTransform = mat4.invert(mat4.create(), sceneTransform);
                assert(inverseTransform !== null);
                const center = vec3.create();
                collision.bounds.centerPoint(center);
                visibilityRoom = { active: true, inverseTransform, center, exteriorRenderer };
                renderer.stitch.exteriorRooms.push(visibilityRoom);
            }
        }

        const entityRenderers = entities?.createRenderers(
            device, renderer.getCache(), lighting, fog, sceneTransform, splitExterior, collision) ?? null;
        if (entities !== null && entityRenderers !== null) {
            renderer.objectRenderers.push(...entityRenderers.renderers);
            renderer.entities.push(entities);
            addedRenderers.push(...entityRenderers.renderers);
        }
        return {
            renderers: addedRenderers,
            doorRenderers: entityRenderers?.doorRenderers ?? new Map(),
            visibilityRoom,
        };
    }
}

const mp: MPHSceneMode = { kind: 'multiplayer', layout: 0 };
const mp_ctf: MPHSceneMode = { kind: 'multiplayer', layout: 0, captureTheFlag: true };

const id = 'mph';
const name = 'Metroid Prime: Hunters';
const campaignAreas = (prefix: string) => (area: MPHAreaMetadata): boolean =>
    area.name.toUpperCase().startsWith(prefix);
const sceneDescs = [
    "Multiplayer",
    new SceneDesc("mp3_Model", "Combat Hall", mp),
    new SceneDesc("mp1_Model", "Data Shrine", mp_ctf),
    new SceneDesc("mp7_model", "Processor Core", mp),
    new SceneDesc("unit1_RM1_model_mp", "High Ground", mp),
    new SceneDesc("mp9_model", "Ice Hive", mp_ctf),
    new SceneDesc("unit1_rm2_model_mp", "Alinos Perch", mp_ctf),
    new SceneDesc("mp12_model", "Sic Transit", mp_ctf),
    new SceneDesc("ad1_model", "Transfer Lock", mp_ctf),
    new SceneDesc("mp11_model", "Sanctorus", mp),
    new SceneDesc("mp5_Model", "Compression Chamber", mp),
    new SceneDesc("mp10_model", "Incubation Vault", mp),
    new SceneDesc("unit4_rm5_model_mp", "Subterranean", mp),
    new SceneDesc("mp14_model", "Outer Reach", mp_ctf),
    new SceneDesc("mp2_model", "Harvester", mp_ctf),
    new SceneDesc("mp8_model", "Weapons Complex", mp_ctf),
    new SceneDesc("ad2_model", "Council Chamber", mp_ctf),
    new SceneDesc("mp4_model", "Elder Passage", mp_ctf),
    new SceneDesc("mp13_model", "Fuel Stack", mp),
    new SceneDesc("ctf1_model", "Fault Line", mp_ctf),
    new SceneDesc("e3Level_Model_mp", "Stasis Bunker", mp_ctf),
    new SceneDesc("mp6_model", "Head Shot", mp_ctf),
    new SceneDesc("unit2_Land_model_mp", "Landing Bay", mp_ctf),
    new SceneDesc("unit1_land_model_mp", "Alinos Landfall", mp),
    new SceneDesc("unit3_land_model_mp", "Vesper Starport", mp_ctf),
    new SceneDesc("unit4_land_model_mp", "Arcterra Base", mp_ctf),
    new SceneDesc("gorea_b2_Model_mp", "Oubliette", mp),
    "Celestial Archives",
    new StitchedSceneDesc("Celestial Archives (all)", "unit2_Land_Ent.bin", campaignAreas("UNIT2_")),
    new SceneDesc("unit2_Land_model", "Celestial Gateway"),
    new SceneDesc("unit2_c0_model", "Helm Room"),
    new SceneDesc("unit2_c1_model", "Meditation Room"),
    new SceneDesc("unit2_c2_model", "Fan Room Alpha"),
    new SceneDesc("unit2_c3_model", "Fan Room Beta"),
    new SceneDesc("unit2_RM3_model", "Data Shrine 03"),
    new SceneDesc("unit2_c4_model", "Synergy Core"),
    new SceneDesc("unit2_rm4_model", "Transfer Lock"),
    new SceneDesc("unit2_rm8_model", "Docking Bay"),
    new SceneDesc("unit2_c6_model", "Tetra Vista"),
    new SceneDesc("unit2_c7_model", "New Arrival Registration"),
    new SceneDesc("unit2_cx_model", "1_CX"),
    new SceneDesc("unit2_cz_model", "1_CZ"),
    "Alinos",
    new StitchedSceneDesc("Alinos (all)", "Unit1_Land_Ent.bin", campaignAreas("UNIT1_")),
    new SceneDesc("unit1_land_model", "Alinos Gateway"),
    new SceneDesc("unit1_c0_model", "Echo Hall"),
    new SceneDesc("unit1_RM1_model", "High Ground"),
    new SceneDesc("unit1_rm6_model", "Elder Passage"),
    new SceneDesc("unit1_c1_model", "Alimbic Gardens"),
    new SceneDesc("unit1_c2_model", "Thermal Vast"),
    new SceneDesc("unit1_rm2_model", "Alinos Perch"),
    new SceneDesc("unit1_rm3_model", "Council Chamber"),
    new SceneDesc("unit1_c3_model", "Crash Site"),
    new SceneDesc("unit1_c4_model", "Magma Drop"),
    new SceneDesc("unit1_c5_model", "Piston Cave"),
    new SceneDesc("crystalroom_model", "Alimbic Cannon Control Room"),
    new SceneDesc("unit1_cx_model", "1_CX"),
    new SceneDesc("unit1_cz_model", "1_CZ"),
    new SceneDesc("unit1_morph_cx_model", "1_morphCX"),
    new SceneDesc("unit1_morph_cz_model", "1_morphCZ"),
    new SceneDesc("unit1_rm1_cx_model", "1_RM_CX"),
    "Vesper Defense Outpost",
    new StitchedSceneDesc("Vesper Defense Outpost (all)", "unit3_Land_Ent.bin", campaignAreas("UNIT3_")),
    new SceneDesc("unit3_land_model", "VDO Gateway"),
    new SceneDesc("unit3_c0_model", "Bioweaponry Lab"),
    new SceneDesc("unit3_rm1_model", "Weapons Complex"),
    new SceneDesc("unit3_c2_model", "Cortex CPU"),
    new SceneDesc("e3Level_Model", "Stasis Bunker"),
    new SceneDesc("unit3_c1_model", "Ascension"),
    new SceneDesc("unit3_rm2_model", "Fuel Stack"),
    new SceneDesc("unit3_cx_model", "3_CX"),
    new SceneDesc("unit3_cz_model", "3_CZ"),
    new SceneDesc("unit3_morph_cz_model", "3_morphCZ"),
    "Arcterra",
    new StitchedSceneDesc("Arcterra (all)", "unit4_Land_Ent.bin", campaignAreas("UNIT4_")),
    new SceneDesc("unit4_land_model", "Arcterra Gateway"),
    new SceneDesc("unit4_rm1_model", "Ice Hive"),
    new SceneDesc("unit4_c0_model", "Frost Labyrinth"),
    new SceneDesc("unit4_rm5_model", "Subterranean"),
    new SceneDesc("unit4_c1_model", "Drip Moat"),
    new SceneDesc("unit4_rm2_model", "Fault Line"),
    new SceneDesc("unit4_cx_model", "4_CX"),
    new SceneDesc("unit4_cz_model", "4_CZ"),
    "Stronghold Void",
    new StitchedSceneDesc("Stronghold Void (all)", "Unit1_TP1_Ent.bin", (area) => campaignAreas("UNIT1_")(area) && /_(?:TP|B)\d$/i.test(area.name)),
    new SceneDesc("TeleportRoom_model", "Stronghold Gateway"),
    new SceneDesc("Cylinder_C1_model", "Biodefense Chamber A Connect"),
    new SceneDesc("cylinderroom_model", "Biodefense Chamber A"),
    new SceneDesc("bigeye_c1_model", "Biodefense Chamber B Connect"),
    new SceneDesc("bigeyeroom_model", "Biodefense Chamber B"),
    "Oubliette",
    new StitchedSceneDesc("Oubliette (all)", "Gorea_Land_Ent.bin", campaignAreas("GOREA_")),
    new SceneDesc("Gorea_Land_Model", "Oubliette Gateway"),
    new SceneDesc("Gorea_b1_Model", "Gorea Room"),
    new SceneDesc("gorea_b2_Model", "Gorea Soul Room"),
    new SceneDesc("Gorea_c1_Model", "Gorea Connect Room(unused)"),
    "TestRooms",
    new SceneDesc("unit1_b2_model", "biodefense chamber 06"),
    new SceneDesc("unit2_b2_model", "biodefense chamber 05"),
    new SceneDesc("unit3_b1_model", "biodefense chamber 03"),
    new SceneDesc("unit3_b2_model", "biodefense chamber 08"),
    new SceneDesc("unit4_b1_model", "biodefense chamber 04"),
    new SceneDesc("unit4_b2_model", "biodefense chamber 07"),
    "FirstHunt",
    new SceneDesc("mp_fh_data/levels/models/blueRoom_Model", "Regulator Stage"),
    new SceneDesc("mp_fh_data/levels/models/e3Level_Model", "Morphball Stage"),
    new SceneDesc("mp_fh_data/levels/models/mp1_Model", "Trooper Module"),
    new SceneDesc("mp_fh_data/levels/models/mp2_Model", "Assault Cradle / Survivour Stage"),
    new SceneDesc("mp_fh_data/levels/models/mp3_Model", "Ancient Vestige"),
    new SceneDesc("mp_fh_data/levels/models/mp5_Model", "MAP 5"),
    new SceneDesc("mp_fh_data/levels/models/testLevel_Model", "Test Room"),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
