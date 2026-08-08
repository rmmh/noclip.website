import * as Viewer from '../viewer.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { SceneContext } from '../SceneBase.js';
import { AABB } from '../Geometry.js';
import { assert, assertExists } from '../util.js';
import { mat3, mat4, ReadonlyVec3, vec3 } from 'gl-matrix';
import { findConnectorMetadata, MPHAreaMetadata, MPHConnectorMetadata } from './area_metadata.js';
import { MPHCollisionData, parseMPHCollision } from './mph_collision.js';
import { MPHDoorEntity, MPHEntityFile, MPHTeleporterEntity, normalizeEntityFilename, parseMPHEntities } from './entity.js';
import { MPHbin, parseMPH_Model } from './mph_binModel.js';
import { MPHRenderer } from './render.js';
import { MPHSceneRenderer, SceneDesc } from './Scenes_MetroidPrimeHunters.js';

const backdropMargin = vec3.fromValues(16, 16, 16);

export class StitchedSceneDesc implements Viewer.SceneDesc {
    public id: string;

    constructor(public name: string, private rootEntityFilename: string, private areaFilter: (area: MPHAreaMetadata) => boolean) {
        this.id = `${this.rootEntityFilename.replace(/_ent\.bin$/i, '')}_all`;
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const renderer = new MPHSceneRenderer(device, context.dataFetcher);
        await renderer.fetchMetadata();
        const modelCache = renderer.modelCache;
        const entityMetadata = renderer.metadata.entities;
        const areas = renderer.metadata.areas.filter(this.areaFilter);
        for (const area of areas)
            modelCache.fetchMPFile(`levels/entities/${area.entityFilename}`);
        await modelCache.waitForLoad();

        const roomsByEntityFilename = new Map<string, MPHLoadedStitchedRoom>();
        await Promise.all(areas.map(async (area) => {
            const desc = sceneDescFromArea(area);
            const archiveName = renderer.metadata.modelArchives[area.modelFilename.toLowerCase()] ??
                area.modelFilename.replace(/_model\.bin$/i, '');
            await modelCache.fetchMPHARC(`archives/${archiveName}.arc`);
            const collision = parseMPHCollision(assertExists(modelCache.getFileData(area.collisionFilename)));
            const entityFile = assertExists(modelCache.getFileData(`levels/entities/${area.entityFilename}`));
            const entityLayer = new MPHEntityFile(parseMPHEntities(entityFile, 0), entityMetadata, modelCache,
                { kind: 'singlePlayer', geometrySet: area.geometrySet ?? 1 }, area.entityFilename);
            const normalizedEntityFilename = normalizeEntityFilename(area.entityFilename);
            roomsByEntityFilename.set(normalizedEntityFilename, {
                area,
                desc,
                entityFilename: area.entityFilename,
                normalizedEntityFilename,
                entityLayer,
                transform: null,
                bounds: toViewerAABB(collision.bounds),
            });
        }));

        const connectorBoundsById = new Map<number, AABB>();
        const usedConnectorIds = new Set<number>();
        for (const room of roomsByEntityFilename.values())
            for (const door of room.entityLayer.doors)
                if (door.connectorLevelId !== 0xFF)
                    usedConnectorIds.add(door.connectorLevelId);
        await Promise.all([...usedConnectorIds].map(async (connectorId) => {
            const connector = findConnectorMetadata(connectorId);
            if (!connector) {
                console.warn(`[MPH stitch] connector LevelInfo ${connectorId} is not transcribed.`);
                return;
            }
            await modelCache.fetchMPHARC(`archives/${connector.archiveName}.arc`);
            const collision = parseMPHCollision(assertExists(modelCache.getFileData(connector.collisionFilename)));
            connectorBoundsById.set(connectorId, toViewerAABB(collision.bounds));
        }));
        const root = assertExists(roomsByEntityFilename.get(normalizeEntityFilename(this.rootEntityFilename)));
        root.transform = mat4.create();
        const layout: MPHStitchLayout = {
            roomsByEntityFilename,
            connectorBoundsById,
            stitchedConnectors: [],
            processedDoorEdges: new Set(),
            root,
            placedRooms: [],
            placedConnectors: [],
        };
        const rootComponent = expandDoorComponent(layout, root);
        layout.placedRooms.push(...rootComponent.rooms);
        layout.placedConnectors.push(...rootComponent.connectors);

        while (true) {
            let addedIsland = false;
            for (const sourceRoom of roomsByEntityFilename.values()) {
                if (sourceRoom.transform === null)
                    continue;
                for (const sourceTeleporter of sourceRoom.entityLayer.teleporters) {
                    const destinationRoom = roomsByEntityFilename.get(sourceTeleporter.destinationEntityFilename);
                    if (!destinationRoom || destinationRoom.transform) continue;
                    const destinationTeleporter: MPHTeleporterEntity | undefined = destinationRoom.entityLayer.teleporters.find((teleporter) =>
                        teleporter.destinationRoom === sourceTeleporter.destinationRoom &&
                        teleporter.destinationEntity === sourceTeleporter.destinationEntity &&
                        teleporter.destinationEntityFilename === sourceRoom.normalizedEntityFilename);
                    if (destinationTeleporter === undefined) {
                        continue;
                    }
                    // Teleporters don't force positioning like rooms do.
                    placeIsland(layout, destinationRoom, sourceRoom, sourceTeleporter, destinationTeleporter);
                    addedIsland = true;
                    break;
                }
                if (addedIsland)
                    break;
            }
            if (!addedIsland)
                break;
        }

        // Story transitions can cause a teleport without a spatial constraint.
        for (const room of roomsByEntityFilename.values())
            if (room.transform === null)
                placeIsland(layout, room);

        const placedRooms = [...roomsByEntityFilename.values()];
        const loadedRooms = await Promise.all(placedRooms.map((room) =>
            room.desc.addToScene(device, renderer, { sceneTransform: assertExists(room.transform), splitExterior: true })));

        const visibilityChunksByRoom = new Map<MPHLoadedStitchedRoom, MPHStitchedVisibilityChunk>();
        const doorRenderersByRoom = new Map<MPHLoadedStitchedRoom, Map<number, MPHRenderer>>();
        for (let i = 0; i < placedRooms.length; i++) {
            const room = placedRooms[i];
            const loaded = loadedRooms[i];
            doorRenderersByRoom.set(room, loaded.doorRenderers);
            // Doors belong to the connector chunk so both doors are visible from either side.
            const connectedDoorIds = layout.stitchedConnectors.flatMap((connector) => {
                if (connector.sourceRoom === room)
                    return [connector.sourceDoor.entityId];
                if (connector.destinationRoom === room)
                    return [connector.destinationDoor.entityId];
                return [];
            });
            const connectedDoorRenderers = new Set(connectedDoorIds.map((entityId) =>
                assertExists(loaded.doorRenderers.get(entityId))));
            const visibilityChunk: MPHStitchedVisibilityChunk = {
                inverseTransform: mat4.invert(mat4.create(), assertExists(room.transform)),
                bounds: room.bounds,
                renderers: loaded.renderers.filter((renderer) => !connectedDoorRenderers.has(renderer)),
                exteriorRoom: loaded.visibilityRoom,
                neighbors: new Set(),
                visible: true,
            };
            renderer.stitch.chunks.push(visibilityChunk);
            visibilityChunksByRoom.set(room, visibilityChunk);
        }

        const loadedConnectors = await Promise.all(layout.stitchedConnectors.map((connector) =>
            connector.desc.addToScene(device, renderer, { sceneTransform: connector.transform, renderEntities: false })));
        for (let i = 0; i < layout.stitchedConnectors.length; i++) {
            const connector = layout.stitchedConnectors[i];
            const loaded = loadedConnectors[i];
            const connectorChunk: MPHStitchedVisibilityChunk = {
                inverseTransform: mat4.invert(mat4.create(), connector.transform),
                bounds: connector.bounds,
                renderers: [
                    ...loaded.renderers,
                    assertExists(doorRenderersByRoom.get(connector.sourceRoom)?.get(connector.sourceDoor.entityId)),
                    assertExists(doorRenderersByRoom.get(connector.destinationRoom)?.get(connector.destinationDoor.entityId)),
                ],
                exteriorRoom: null,
                neighbors: new Set(),
                visible: true,
            };
            renderer.stitch.chunks.push(connectorChunk);
            const sourceChunk = assertExists(visibilityChunksByRoom.get(connector.sourceRoom));
            const destinationChunk = assertExists(visibilityChunksByRoom.get(connector.destinationRoom));
            connectorChunk.neighbors.add(sourceChunk);
            connectorChunk.neighbors.add(destinationChunk);
            sourceChunk.neighbors.add(connectorChunk);
            destinationChunk.neighbors.add(connectorChunk);
        }
        return renderer;
    }
}

function nodeIsExterior(stageBin: MPHbin, collision: MPHCollisionData | null, nodeIndex: number): boolean {
    const node = stageBin.nodes[nodeIndex];
    for (let i = 0; i < node.meshCount; i++) {
        const mesh = stageBin.meshs[node.meshStart + i];
        if (/^(?:space|sky|stars?)$/i.test(stageBin.materials[mesh.matID].name))
            return true;
    }
    if (/(?:sky|space|background|backdrop|horizon|outside|distant|^fog\d*$|^movingIce\d*$)/i.test(node.name))
        return true;
    if (collision === null)
        return false;
    if (!AABB.intersect(node.bbox, collision.bounds))
        return true;
    const backdropBounds = new AABB();
    backdropBounds.expandByExtent(collision.bounds, backdropMargin);
    return node.bbox.containsPoint(backdropBounds.min) && node.bbox.containsPoint(backdropBounds.max);
}

export function findExteriorNodes(stageBin: MPHbin, collision: MPHCollisionData | null): Set<string> {
    const exteriorNodes = new Set<string>();
    for (let i = 0; i < stageBin.nodes.length; i++)
        if (nodeIsExterior(stageBin, collision, i))
            exteriorNodes.add(stageBin.nodes[i].name);
    return exteriorNodes;
}

export interface MPHStitchedExteriorRoom {
    active: boolean;
    inverseTransform: mat4;
    center: vec3;
    exteriorRenderer: MPHRenderer;
}

export interface MPHStitchedVisibilityChunk {
    inverseTransform: mat4;
    bounds: AABB;
    renderers: MPHRenderer[];
    exteriorRoom: MPHStitchedExteriorRoom | null;
    neighbors: Set<MPHStitchedVisibilityChunk>;
    visible: boolean;
}

const scratchCameraPosition = vec3.create();
const scratchChunkCameraPosition = vec3.create();

export class MPHStitchController {
    public exteriorRooms: MPHStitchedExteriorRoom[] = [];
    public chunks: MPHStitchedVisibilityChunk[] = [];

    public prepareToRender(viewerInput: Viewer.ViewerRenderInput): void {
        vec3.set(scratchCameraPosition, viewerInput.camera.worldMatrix[12], viewerInput.camera.worldMatrix[13], viewerInput.camera.worldMatrix[14]);
        let containingChunk: MPHStitchedVisibilityChunk | null = null;
        let containingChunkCenterDistance = Infinity;
        for (const chunk of this.chunks) {
            vec3.transformMat4(scratchChunkCameraPosition, scratchCameraPosition, chunk.inverseTransform);
            if (!chunk.bounds.containsPoint(scratchChunkCameraPosition))
                continue;
            const centerDistance = chunk.bounds.distFromCenter(scratchChunkCameraPosition);
            if (centerDistance < containingChunkCenterDistance) {
                containingChunk = chunk;
                containingChunkCenterDistance = centerDistance;
            }
        }

        if (containingChunk) {
            for (const chunk of this.chunks)
                chunk.visible = false;

            containingChunk.visible = true;
            for (const neighbor of containingChunk.neighbors)
                neighbor.visible = true;
        } else {
            for (const chunk of this.chunks)
                chunk.visible = true;
        }

        for (const chunk of this.chunks) {
            for (const renderer of chunk.renderers)
                renderer.visible = chunk.visible;
            if (chunk.exteriorRoom)
                chunk.exteriorRoom.active = chunk.visible;
        }

        let nearestRoom: MPHStitchedExteriorRoom | null = null;
        let nearestDistance = Infinity;
        for (const room of this.exteriorRooms) {
            room.exteriorRenderer.visible = false;
            if (!room.active)
                continue;
            vec3.transformMat4(scratchChunkCameraPosition, scratchCameraPosition, room.inverseTransform);
            const distance = vec3.squaredDistance(scratchChunkCameraPosition, room.center);
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestRoom = room;
            }
        }
        if (nearestRoom !== null)
            nearestRoom.exteriorRenderer.visible = true;
    }
}

interface MPHLoadedStitchedRoom {
    area: MPHAreaMetadata;
    desc: SceneDesc;
    entityFilename: string;
    normalizedEntityFilename: string;
    entityLayer: MPHEntityFile;
    transform: mat4 | null;
    bounds: AABB;
}

interface MPHStitchedConnector {
    desc: SceneDesc;
    sourceRoom: MPHLoadedStitchedRoom;
    destinationRoom: MPHLoadedStitchedRoom;
    sourceDoor: MPHDoorEntity;
    destinationDoor: MPHDoorEntity;
    transform: mat4;
    bounds: AABB;
}

function toViewerAABB(bounds: AABB): AABB {
    const { min, max } = bounds;
    return new AABB(min[0], min[1], min[2], max[0], max[1], max[2]);
}

function transformAABB(bounds: AABB, transform: mat4): AABB {
    const worldBounds = new AABB();
    worldBounds.transform(bounds, transform);
    return worldBounds;
}

interface MPHOrientedEndpoint {
    position: ReadonlyVec3;
    up: ReadonlyVec3;
    facing: ReadonlyVec3;
}

function makeEndpointFrame(endpoint: MPHOrientedEndpoint): mat4 {
    const target = vec3.sub(vec3.create(), endpoint.position, endpoint.facing);
    return mat4.targetTo(mat4.create(), endpoint.position, target, endpoint.up);
}

function alignDestinationRoom(sourceTransform: mat4, sourceEndpoint: MPHOrientedEndpoint, destinationEndpoint: MPHOrientedEndpoint): mat4 {
    const sourceFrame = makeEndpointFrame(sourceEndpoint);
    const destinationFrameInverse = mat4.invert(mat4.create(), makeEndpointFrame(destinationEndpoint));
    assert(destinationFrameInverse !== null);
    const transform = mat4.mul(mat4.create(), sourceTransform, sourceFrame);
    mat4.rotateY(transform, transform, Math.PI);  // reciprocal doors face into respective rooms
    return mat4.mul(transform, transform, destinationFrameInverse);
}

function calcConnectorTransforms(sourceTransform: mat4, sourceDoor: MPHDoorEntity, destinationDoor: MPHDoorEntity, connector: MPHConnectorMetadata): { connector: mat4, destination: mat4 } {
    // PlaceAndLoadAdjacentLevelThroughDoor @ 0x02104B80
    const displacement = vec3.fromValues(...connector.displacement);
    if (sourceDoor.facing[0] >= 0xB51 / 0x1000 || sourceDoor.facing[2] >= 0xB51 / 0x1000)
        vec3.negate(displacement, displacement);
    const connectorOrigin = vec3.scaleAndAdd(vec3.create(), sourceDoor.position, displacement, 0.5);
    const connectorTransform = mat4.mul(
        mat4.create(),
        sourceTransform,
        mat4.fromTranslation(mat4.create(), connectorOrigin),
    );

    const worldDisplacement = vec3.clone(displacement);
    vec3.transformMat3(worldDisplacement, worldDisplacement, mat3.fromMat4(mat3.create(), sourceTransform));
    const destinationTransform = alignDestinationRoom(sourceTransform, sourceDoor, destinationDoor);
    mat4.mul(destinationTransform, mat4.fromTranslation(mat4.create(), worldDisplacement), destinationTransform);
    return { connector: connectorTransform, destination: destinationTransform };
}

function sceneDescFromArea(area: MPHAreaMetadata): SceneDesc {
    const modelId = area.modelFilename.replace(/\.bin$/i, '');
    return new SceneDesc(modelId, area.name,
        { kind: 'singlePlayer', geometrySet: area.geometrySet ?? 1 }, area, modelId);
}

function sceneDescFromConnector(connector: MPHConnectorMetadata, lightingArea: MPHAreaMetadata): SceneDesc {
    const area: MPHAreaMetadata = {
        ...lightingArea,
        sourceAddress: 0x020B7BC4 + connector.id * 0x70,
        name: connector.name,
        modelFilename: connector.modelFilename,
        animationFilename: connector.animationFilename,
        textureFilename: '',
        collisionFilename: connector.collisionFilename,
        entityFilename: '',
        nodeFilename: '',
    };
    const modelId = connector.modelFilename.replace(/\.bin$/i, '');
    return new SceneDesc(`${modelId}_${connector.id}`, connector.name,
        { kind: 'singlePlayer', geometrySet: area.geometrySet ?? 1 }, area, modelId, connector.archiveName);
}

interface MPHStitchLayout {
    roomsByEntityFilename: Map<string, MPHLoadedStitchedRoom>;
    connectorBoundsById: Map<number, AABB>;
    stitchedConnectors: MPHStitchedConnector[];
    processedDoorEdges: Set<string>;
    root: MPHLoadedStitchedRoom;
    placedRooms: MPHLoadedStitchedRoom[];
    placedConnectors: MPHStitchedConnector[];
}

interface MPHStitchedComponent {
    rooms: MPHLoadedStitchedRoom[];
    connectors: MPHStitchedConnector[];
}

const islandPackingMargin = 64;
const placementStep = 128;
const maxPlacementDistance = 1 << 17;

const packingMarginExtent = vec3.fromValues(islandPackingMargin, islandPackingMargin, islandPackingMargin);

function placementIsClear(moving: readonly AABB[], placed: readonly AABB[], offset: vec3): boolean {
    for (const bounds of moving) {
        const placementBounds = new AABB();
        placementBounds.offset(bounds, offset);
        placementBounds.expandByExtent(placementBounds, packingMarginExtent);
        for (const occupied of placed)
            if (AABB.intersect(placementBounds, occupied))
                return false;
    }
    return true;
}

function expandDoorComponent(layout: MPHStitchLayout, seed: MPHLoadedStitchedRoom): MPHStitchedComponent {
    function makeDoorEdgeKey(sourceRoom: MPHLoadedStitchedRoom, destinationRoom: MPHLoadedStitchedRoom, connectionId: number): string {
        const names = [sourceRoom.normalizedEntityFilename, destinationRoom.normalizedEntityFilename].sort();
        return `${names[0]}|${names[1]}|${connectionId}`;
    }

    const queue = [seed];
    const rooms = [seed];
    const firstConnector = layout.stitchedConnectors.length;

    while (queue.length !== 0) {
        const sourceRoom = queue.shift()!;
        const sourceTransform = assertExists(sourceRoom.transform);
        for (const sourceDoor of sourceRoom.entityLayer.doors) {
            if (sourceDoor.connectionId === 0xFF || sourceDoor.destinationEntityFilename === '')
                continue;
            const destinationRoom = layout.roomsByEntityFilename.get(sourceDoor.destinationEntityFilename);
            if (!destinationRoom)
                continue;
            const destinationDoor = destinationRoom.entityLayer.doors.find((door) =>
                door.connectionId === sourceDoor.connectionId &&
                door.destinationEntityFilename === sourceRoom.normalizedEntityFilename);
            if (!destinationDoor)
                continue;

            const edgeKey = makeDoorEdgeKey(sourceRoom, destinationRoom, sourceDoor.connectionId);
            if (layout.processedDoorEdges.has(edgeKey))
                continue;
            layout.processedDoorEdges.add(edgeKey);

            const connector = findConnectorMetadata(sourceDoor.connectorLevelId);
            const connectorBounds = layout.connectorBoundsById.get(sourceDoor.connectorLevelId);
            if (connector === undefined || connectorBounds === undefined) {
                console.warn(`[MPH stitch] ${sourceRoom.entityFilename} connection ${sourceDoor.connectionId}: connector LevelInfo ${sourceDoor.connectorLevelId} could not be loaded.`);
                continue;
            }

            const transforms = calcConnectorTransforms(sourceTransform, sourceDoor, destinationDoor, connector);
            layout.stitchedConnectors.push({
                desc: sceneDescFromConnector(connector, sourceRoom.area),
                sourceRoom,
                destinationRoom,
                sourceDoor,
                destinationDoor,
                transform: transforms.connector,
                bounds: connectorBounds,
            });

            if (destinationRoom.transform === null) {
                destinationRoom.transform = transforms.destination;
                queue.push(destinationRoom);
                rooms.push(destinationRoom);
            } else {
                const existingPosition = mat4.getTranslation(vec3.create(), destinationRoom.transform);
                const candidatePosition = mat4.getTranslation(vec3.create(), transforms.destination);
                const closureError = vec3.distance(existingPosition, candidatePosition);
                if (closureError > 1)
                    console.warn(`[MPH stitch] ${sourceRoom.entityFilename} -> ${destinationRoom.entityFilename} connection ${sourceDoor.connectionId}: non-Euclidean cycle closure differs by ${closureError.toFixed(2)} viewer units.`);
            }
        }
    }
    return { rooms, connectors: layout.stitchedConnectors.slice(firstConnector) };
}

function placeIsland(layout: MPHStitchLayout, room: MPHLoadedStitchedRoom, sourceRoom: MPHLoadedStitchedRoom | null = null, sourceEndpoint: MPHOrientedEndpoint | null = null, destinationEndpoint: MPHOrientedEndpoint | null = null): void {
    room.transform = mat4.create();
    const component = expandDoorComponent(layout, room);
    const componentBounds = component.rooms.map((componentRoom) =>
        transformAABB(componentRoom.bounds, assertExists(componentRoom.transform)));
    componentBounds.push(...component.connectors.map((connector) =>
        transformAABB(connector.bounds, connector.transform)));
    const placedBounds = layout.placedRooms.map((placedRoom) =>
        transformAABB(placedRoom.bounds, assertExists(placedRoom.transform)));
    placedBounds.push(...layout.placedConnectors.map((connector) =>
        transformAABB(connector.bounds, connector.transform)));

    const sourcePoint = vec3.create();
    const destinationPoint = vec3.create();
    if (sourceRoom !== null && sourceEndpoint !== null && destinationEndpoint !== null) {
        vec3.copy(sourcePoint, sourceEndpoint.position);
        vec3.transformMat4(sourcePoint, sourcePoint, assertExists(sourceRoom.transform));
        vec3.copy(destinationPoint, destinationEndpoint.position);
        vec3.transformMat4(destinationPoint, destinationPoint, assertExists(room.transform));
    } else {
        const rootBounds = transformAABB(layout.root.bounds, assertExists(layout.root.transform));
        rootBounds.centerPoint(sourcePoint);
        componentBounds[0].centerPoint(destinationPoint);
    }
    const coincidentOffset = vec3.sub(vec3.create(), sourcePoint, destinationPoint);

    const directions: vec3[] = [];
    for (let i = 0; i < 32; i++) {
        const angle = i * Math.PI * 2 / 32;
        directions.push(vec3.fromValues(Math.cos(angle), 0, Math.sin(angle)));
    }

    let bestOffset: vec3 | null = null;
    const candidateOffset = vec3.create();
    for (let distance = 0; distance <= maxPlacementDistance && bestOffset === null; distance += placementStep) {
        for (const direction of directions) {
            vec3.scaleAndAdd(candidateOffset, coincidentOffset, direction, distance);
            if (placementIsClear(componentBounds, placedBounds, candidateOffset)) {
                bestOffset = vec3.clone(candidateOffset);
                break;
            }
        }
    }

    assert(bestOffset !== null, "could not place external candidate")

    const translation = mat4.fromTranslation(mat4.create(), bestOffset);
    for (const componentRoom of component.rooms)
        mat4.mul(assertExists(componentRoom.transform), translation, assertExists(componentRoom.transform));
    for (const connector of component.connectors)
        mat4.mul(connector.transform, translation, connector.transform);
    layout.placedRooms.push(...component.rooms);
    layout.placedConnectors.push(...component.connectors);
}
