import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { mat4, quat, ReadonlyQuat, ReadonlyVec3, vec3 } from 'gl-matrix';
import { assert, assertExists, readString } from '../util.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { fx32, TEX0 } from '../nns_g3d/NNS_G3D.js';
import { MPHAnimation, parseMPHAnimation } from './mph_anim.js';
import { fxAngle, MPHbin, parseMPH_Model, parseTEX0Texture } from './mph_binModel.js';
import { MPHFogConfig, MPHLighting, MPHRenderer, MPHRendererOptions, MPHSceneMode } from './render.js';

const ENTITY_HEADER_SIZE = 0x24;
const ENTITY_ENTRY_SIZE = 0x18;
const ENTITY_TYPE_PLATFORM = 0;
const ENTITY_TYPE_OBJECT = 1;
const ENTITY_TYPE_DOOR = 3;
const ENTITY_TYPE_ITEM_SPAWN = 4;
const ENTITY_TYPE_JUMP_PAD = 9;
const ENTITY_TYPE_OCTOLITH_FLAG = 12;
const ENTITY_TYPE_FLAG_BASE = 13;
const ENTITY_TYPE_TELEPORTER = 14;
const ENTITY_TYPE_LIGHT_SOURCE = 16;
const ENTITY_TYPE_ARTIFACT = 17;
const ENTITY_TYPE_FORCE_FIELD = 19;
const PLATFORM_DATA_SIZE = 0x24C;
const OBJECT_DATA_SIZE = 0x98;
const DOOR_DATA_SIZE = 0x68;
const ITEM_SPAWN_DATA_SIZE = 0x48;
const JUMP_PAD_DATA_SIZE = 0x94;
const OCTOLITH_FLAG_DATA_SIZE = 0x29;
const FLAG_BASE_DATA_SIZE = 0x6C;
const TELEPORTER_DATA_SIZE = 0x5C;
const LIGHT_SOURCE_DATA_SIZE = 0x88;
const ARTIFACT_DATA_SIZE = 0x46;
const FORCE_FIELD_DATA_SIZE = 0x35;

interface MPHEntityEntry {
    nodeName: string;
    layerMask: number;
    dataOffset: number;
    dataLength: number;
    type: number;
    entityId: number;
}

interface MPHPlatformEntity extends MPHEntityEntry {
    modelId: number;
    active: boolean;
    delay: number;
    position: ReadonlyVec3;
    up: ReadonlyVec3;
    facing: ReadonlyVec3;
    positions: ReadonlyVec3[];
    rotations: ReadonlyQuat[];
    positionOffset: ReadonlyVec3;
    forwardSpeed: number;
    backwardSpeed: number;
    movementType: number;
    reverseType: number;
    flags: number;
    path: MPHPlatformPath;
}

interface MPHObjectEntity extends MPHEntityEntry {
    position: ReadonlyVec3;
    up: ReadonlyVec3;
    facing: ReadonlyVec3;
    modelId: number;
    initialState: number;
}

export interface MPHDoorEntity extends MPHEntityEntry {
    position: ReadonlyVec3;
    up: ReadonlyVec3;
    facing: ReadonlyVec3;
    subtype: number;
    doorType: number;
    connectorLevelId: number;
    connectionId: number;
    destinationEntityFilename: string;
}

export function normalizeEntityFilename(filename: string): string {
    return filename.trim().toLowerCase().replace(/_ent\.(?:b(?:i)?)?$/, '_ent.bin');
}

interface MPHItemSpawnEntity extends MPHEntityEntry {
    position: ReadonlyVec3;
    parentEntityId: number;
    itemId: number;
    initialState: number;
}

interface MPHJumpPadEntity extends MPHEntityEntry {
    position: vec3;
    up: vec3;
    facing: vec3;
    launchDirection: vec3;
    active: boolean;
    modelId: number;
    beamModelId: number;
}

interface MPHOctolithFlagEntity extends MPHEntityEntry {
    position: vec3;
    up: vec3;
    facing: vec3;
    teamId: number;
}

interface MPHFlagBaseEntity extends MPHEntityEntry {
    position: vec3;
    up: vec3;
    facing: vec3;
    teamId: number;
    active: boolean;
}

type MPHLightVolume =
    { kind: 'box', axes: readonly [vec3, vec3, vec3], origin: vec3, extents: vec3 } |
    { kind: 'cylinder', axis: vec3, origin: vec3, radius: number, length: number } |
    { kind: 'sphere', origin: vec3, radius: number };

interface MPHLightSourceEntity extends MPHEntityEntry {
    volume: MPHLightVolume;
    light0Enabled: boolean;
    light0Color: [number, number, number];
    light0Direction: vec3;
    light1Enabled: boolean;
    light1Color: [number, number, number];
    light1Direction: vec3;
}

interface MPHArtifactEntity extends MPHEntityEntry {
    position: vec3;
    up: vec3;
    facing: vec3;
    artifactId: number;
    active: boolean;
}

export interface MPHTeleporterEntity extends MPHEntityEntry {
    position: vec3;
    up: vec3;
    facing: vec3;
    destinationRoom: number;
    destinationEntity: number;
    paletteId: number;
    active: boolean;
    invisible: boolean;
    destinationEntityFilename: string;
}

interface MPHForceFieldEntity extends MPHEntityEntry {
    position: vec3;
    up: vec3;
    facing: vec3;
    subtype: number;
    width: number;
    height: number;
    active: boolean;
}

export interface MPHEntities {
    platforms: MPHPlatformEntity[];
    objects: MPHObjectEntity[];
    doors: MPHDoorEntity[];
    itemSpawns: MPHItemSpawnEntity[];
    jumpPads: MPHJumpPadEntity[];
    octolithFlags: MPHOctolithFlagEntity[];
    flagBases: MPHFlagBaseEntity[];
    lightSources: MPHLightSourceEntity[];
    artifacts: MPHArtifactEntity[];
    teleporters: MPHTeleporterEntity[];
    forceFields: MPHForceFieldEntity[];
}

interface MPHEntityModelSpec {
    modelFilename: string;
    animationFilename?: string;
    sharedTextureFilename?: string;
    paletteFilename?: string;
    paletteOverrides?: readonly { target: number; source: number }[];
    animationId?: number;
}

export interface MPHEntityResourceCache {
    fetchMPFile(path: string): Promise<void>;
    fetchMPHARC(path: string): Promise<void>;
    getFileData(path: string): ArrayBufferSlice | null;
}

function readFx32(view: DataView, offs: number): number {
    return fx32(view.getInt32(offs, true));
}

function readVec3Fx(view: DataView, offs: number): vec3 {
    return vec3.fromValues(readFx32(view, offs + 0x00), readFx32(view, offs + 0x04), readFx32(view, offs + 0x08));
}

function readNormalizedVec3Fx(view: DataView, offs: number): vec3 {
    const dst = readVec3Fx(view, offs);
    return vec3.normalize(dst, dst);
}

function readQuatFx(view: DataView, offs: number): quat {
    const dst = quat.fromValues(readFx32(view, offs + 0x00), readFx32(view, offs + 0x04), readFx32(view, offs + 0x08), readFx32(view, offs + 0x0C));
    return quat.normalize(dst, dst);
}

function parsePlatform(entry: MPHEntityEntry, view: DataView): MPHPlatformEntity {
    assert(entry.dataLength === PLATFORM_DATA_SIZE);
    const offs = entry.dataOffset;
    const positionCount = view.getUint16(offs + 0x3E, true);
    assert(positionCount <= 10);

    const positions: vec3[] = [];
    const rotations: quat[] = [];
    for (let i = 0; i < positionCount; i++) {
        positions.push(readVec3Fx(view, offs + 0x40 + i * 0x0C));
        rotations.push(readQuatFx(view, offs + 0xB8 + i * 0x10));
    }

    const platform: MPHPlatformPathSource = {
        ...entry,
        modelId: view.getUint32(offs + 0x2C, true),
        active: view.getUint8(offs + 0x32) !== 0,
        delay: view.getUint8(offs + 0x33),
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        positions,
        rotations,
        positionOffset: readVec3Fx(view, offs + 0x158),
        forwardSpeed: readFx32(view, offs + 0x164),
        backwardSpeed: readFx32(view, offs + 0x168),
        movementType: view.getUint32(offs + 0x17C, true),
        reverseType: view.getUint32(offs + 0x184, true),
        flags: view.getUint32(offs + 0x188, true),
    };
    return { ...platform, path: buildPlatformPath(platform) };
}

function parseObject(entry: MPHEntityEntry, view: DataView): MPHObjectEntity {
    assert(entry.dataLength === OBJECT_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        modelId: view.getInt32(offs + 0x30, true),
        initialState: view.getUint8(offs + 0x28) & 0x03,
    };
}

function parseDoor(entry: MPHEntityEntry, view: DataView, buffer: ArrayBufferSlice): MPHDoorEntity {
    assert(entry.dataLength === DOOR_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        subtype: view.getUint32(offs + 0x38, true),
        doorType: view.getUint32(offs + 0x3C, true),
        connectorLevelId: view.getUint32(offs + 0x40, true),
        connectionId: view.getUint8(offs + 0x46),
        destinationEntityFilename: normalizeEntityFilename(readString(buffer, offs + 0x48, 0x10, true)),
    };
}

function parseItemSpawn(entry: MPHEntityEntry, view: DataView): MPHItemSpawnEntity {
    assert(entry.dataLength === ITEM_SPAWN_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        parentEntityId: view.getInt16(offs + 0x28, true),
        itemId: view.getUint32(offs + 0x2C, true),
        initialState: view.getUint8(offs + 0x30),
    };
}

function parseJumpPad(entry: MPHEntityEntry, view: DataView): MPHJumpPadEntity {
    assert(entry.dataLength === JUMP_PAD_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        launchDirection: readVec3Fx(view, offs + 0x70),
        active: view.getUint8(offs + 0x84) !== 0,
        modelId: view.getUint32(offs + 0x88, true),
        beamModelId: view.getUint32(offs + 0x8C, true),
    };
}

function parseOctolithFlag(entry: MPHEntityEntry, view: DataView): MPHOctolithFlagEntity {
    assert(entry.dataLength === OCTOLITH_FLAG_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readNormalizedVec3Fx(view, offs + 0x10),
        facing: readNormalizedVec3Fx(view, offs + 0x1C),
        teamId: view.getUint8(offs + 0x28),
    };
}

function parseFlagBase(entry: MPHEntityEntry, view: DataView): MPHFlagBaseEntity {
    assert(entry.dataLength === FLAG_BASE_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        teamId: view.getUint32(offs + 0x28, true),
        active: view.getUint32(offs + 0x2C, true) !== 0,
    };
}

function parseLightSource(entry: MPHEntityEntry, view: DataView): MPHLightSourceEntity {
    assert(entry.dataLength === LIGHT_SOURCE_DATA_SIZE);
    const offs = entry.dataOffset;
    const position = readVec3Fx(view, offs + 0x04);
    const volumeType = view.getUint32(offs + 0x28, true);
    let volume: MPHLightVolume;
    if (volumeType === 0) {
        volume = {
            kind: 'box',
            axes: [
                readVec3Fx(view, offs + 0x2C),
                readVec3Fx(view, offs + 0x38),
                readVec3Fx(view, offs + 0x44),
            ],
            origin: readVec3Fx(view, offs + 0x50),
            extents: readVec3Fx(view, offs + 0x5C),
        };
    } else if (volumeType === 1) {
        volume = {
            kind: 'cylinder',
            axis: readVec3Fx(view, offs + 0x2C),
            origin: readVec3Fx(view, offs + 0x38),
            radius: readFx32(view, offs + 0x48),
            length: readFx32(view, offs + 0x4C),
        };
    } else {
        assert(volumeType === 2);
        volume = {
            kind: 'sphere',
            origin: readVec3Fx(view, offs + 0x2C),
            radius: readFx32(view, offs + 0x38),
        };
    }
    vec3.add(volume.origin, volume.origin, position);
    return {
        ...entry,
        volume,
        light0Enabled: view.getUint8(offs + 0x68) !== 0,
        light0Color: [view.getUint8(offs + 0x69) >> 3, view.getUint8(offs + 0x6A) >> 3, view.getUint8(offs + 0x6B) >> 3],
        light0Direction: readNormalizedVec3Fx(view, offs + 0x6C),
        light1Enabled: view.getUint8(offs + 0x78) !== 0,
        light1Color: [view.getUint8(offs + 0x79) >> 3, view.getUint8(offs + 0x7A) >> 3, view.getUint8(offs + 0x7B) >> 3],
        light1Direction: readNormalizedVec3Fx(view, offs + 0x7C),
    };
}

function parseArtifact(entry: MPHEntityEntry, view: DataView): MPHArtifactEntity {
    assert(entry.dataLength === ARTIFACT_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        artifactId: view.getUint8(offs + 0x28),
        active: view.getUint8(offs + 0x2A) !== 0,
    };
}

function pointInsideLightSource(light: MPHLightSourceEntity, point: vec3): boolean {
    const volume = light.volume;
    if (volume.kind === 'box') {
        const delta = vec3.sub(vec3.create(), point, volume.origin);
        for (let i = 0; i < 3; i++) {
            const distance = vec3.dot(volume.axes[i], delta);
            if (distance < 0 || distance > volume.extents[i])
                return false;
        }
        return true;
    } else if (volume.kind === 'cylinder') {
        const delta = vec3.sub(vec3.create(), point, volume.origin);
        const distanceAlongAxis = vec3.dot(volume.axis, delta);
        if (distanceAlongAxis < 0 || distanceAlongAxis > volume.length)
            return false;
        vec3.scaleAndAdd(delta, delta, volume.axis, -distanceAlongAxis);
        return vec3.squaredLength(delta) <= volume.radius * volume.radius;
    } else {
        return vec3.squaredDistance(point, volume.origin) <= volume.radius * volume.radius;
    }
}

function parseTeleporter(entry: MPHEntityEntry, view: DataView, buffer: ArrayBufferSlice): MPHTeleporterEntity {
    assert(entry.dataLength === TELEPORTER_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        destinationRoom: view.getUint8(offs + 0x28),
        destinationEntity: view.getUint8(offs + 0x29),
        paletteId: view.getUint8(offs + 0x2A),
        active: view.getUint8(offs + 0x2B) !== 0,
        invisible: view.getUint8(offs + 0x2C) !== 0,
        destinationEntityFilename: normalizeEntityFilename(readString(buffer, offs + 0x2D, 0x13, true)),
    };
}

function parseForceField(entry: MPHEntityEntry, view: DataView): MPHForceFieldEntity {
    assert(entry.dataLength === FORCE_FIELD_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        subtype: view.getUint32(offs + 0x28, true),
        width: readFx32(view, offs + 0x2C),
        height: readFx32(view, offs + 0x30),
        active: view.getUint8(offs + 0x34) !== 0,
    };
}

export function parseMPHEntities(buffer: ArrayBufferSlice, layerId: number): MPHEntities {
    const view = buffer.createDataView();
    assert(view.getUint32(0x00, true) === 2);
    assert(layerId >= 0 && layerId < 16);

    const platforms: MPHPlatformEntity[] = [];
    const objects: MPHObjectEntity[] = [];
    const doors: MPHDoorEntity[] = [];
    const itemSpawns: MPHItemSpawnEntity[] = [];
    const jumpPads: MPHJumpPadEntity[] = [];
    const octolithFlags: MPHOctolithFlagEntity[] = [];
    const flagBases: MPHFlagBaseEntity[] = [];
    const lightSources: MPHLightSourceEntity[] = [];
    const artifacts: MPHArtifactEntity[] = [];
    const teleporters: MPHTeleporterEntity[] = [];
    const forceFields: MPHForceFieldEntity[] = [];
    let entryCount = 0;
    for (let offs = ENTITY_HEADER_SIZE; offs + ENTITY_ENTRY_SIZE <= view.byteLength; offs += ENTITY_ENTRY_SIZE) {
        const dataOffset = view.getUint32(offs + 0x14, true);
        if (dataOffset === 0)
            break;

        const layerMask = view.getUint16(offs + 0x10, true);
        if ((layerMask & (1 << layerId)) === 0)
            continue;

        entryCount++;
        const dataLength = view.getUint16(offs + 0x12, true);
        assert(dataOffset + dataLength <= view.byteLength);
        const entry: MPHEntityEntry = {
            nodeName: readString(buffer, offs, 0x10, true),
            layerMask,
            dataOffset,
            dataLength,
            type: view.getUint16(dataOffset + 0x00, true),
            entityId: view.getInt16(dataOffset + 0x02, true),
        };
        if (entry.type === ENTITY_TYPE_PLATFORM)
            platforms.push(parsePlatform(entry, view));
        else if (entry.type === ENTITY_TYPE_OBJECT)
            objects.push(parseObject(entry, view));
        else if (entry.type === ENTITY_TYPE_DOOR)
            doors.push(parseDoor(entry, view, buffer));
        else if (entry.type === ENTITY_TYPE_ITEM_SPAWN)
            itemSpawns.push(parseItemSpawn(entry, view));
        else if (entry.type === ENTITY_TYPE_JUMP_PAD)
            jumpPads.push(parseJumpPad(entry, view));
        else if (entry.type === ENTITY_TYPE_OCTOLITH_FLAG)
            octolithFlags.push(parseOctolithFlag(entry, view));
        else if (entry.type === ENTITY_TYPE_FLAG_BASE)
            flagBases.push(parseFlagBase(entry, view));
        else if (entry.type === ENTITY_TYPE_LIGHT_SOURCE)
            lightSources.push(parseLightSource(entry, view));
        else if (entry.type === ENTITY_TYPE_ARTIFACT)
            artifacts.push(parseArtifact(entry, view));
        else if (entry.type === ENTITY_TYPE_TELEPORTER)
            teleporters.push(parseTeleporter(entry, view, buffer));
        else if (entry.type === ENTITY_TYPE_FORCE_FIELD)
            forceFields.push(parseForceField(entry, view));
    }

    assert(entryCount === view.getUint16(0x04 + layerId * 2, true));
    return { platforms, objects, doors, itemSpawns, jumpPads, octolithFlags, flagBases, lightSources, artifacts, teleporters, forceFields };
}

export interface MPHObjectMetadata {
    modelName: string;
    animationName: string | null;
    animationIds: readonly number[];
}

export interface MPHPlatformMetadata {
    modelName: string | null;
    animationName: string | null;
    animationId: number;
}

export interface MPHDoorMetadata {
    modelName: string;
    animationName: string;
}

export interface MPHItemMetadata {
    modelName: string;
    animated: boolean;
}

export interface MPHEntityMetadata {
    objects: readonly MPHObjectMetadata[];
    platforms: readonly MPHPlatformMetadata[];
    doors: readonly MPHDoorMetadata[];
    doorLockPaletteIds: readonly number[];
    items: readonly MPHItemMetadata[];
}

// From LoadObjectSubtypeResources @ 0x0216BB30 and LoadDoorTypeResources @ 0x02106508.
function getSharedTextureFilename(modelName: string): string | undefined {
    const equipment = /^(generic|alimbic|lava|ice|ruins)_(console|monitor|power|scanner|switch)_mdl$/.exec(modelName);
    if (equipment !== null)
        return `${equipment[1]}EquipTextureShare_img_Model.bin`;
    if (modelName === 'ghostswitch_mdl' || modelName === 'alimbicmorphballdoor_mdl')
        return 'AlimbicTextureShare_img_Model.bin';
    return undefined;
}

function getObjectModelSpec(metadata: MPHEntityMetadata, object: MPHObjectEntity): MPHEntityModelSpec | null {
    if (object.modelId === -1)
        return null;
    const object_ = assertExists(metadata.objects[object.modelId], `object model ${object.modelId}`);
    const animationId = object_.animationIds[object.initialState];
    const hasAnimation = object_.animationName !== null && animationId !== undefined && animationId >= 0;
    return {
        modelFilename: `${object_.modelName}_Model.bin`,
        animationFilename: hasAnimation ? `${object_.animationName}_Anim.bin` : undefined,
        sharedTextureFilename: getSharedTextureFilename(object_.modelName),
        animationId: hasAnimation ? animationId : undefined,
    };
}

function getPlatformModelSpec(metadata: MPHEntityMetadata, platform: MPHPlatformEntity): MPHEntityModelSpec | null {
    const platform_ = metadata.platforms[platform.modelId];
    if (platform_ === undefined || platform_.modelName === null)
        return null;
    return {
        modelFilename: `${platform_.modelName}_Model.bin`,
        animationFilename: platform_.animationName !== null ? `${platform_.animationName}_Anim.bin` : undefined,
        animationId: platform_.animationName !== null ? platform_.animationId : undefined,
    };
}

function getItemModelSpec(metadata: MPHEntityMetadata, item: MPHItemSpawnEntity): MPHEntityModelSpec {
    const item_ = assertExists(metadata.items[item.itemId], `item type ${item.itemId}`);
    return {
        modelFilename: `${item_.modelName}_Model.bin`,
        animationFilename: item_.animated ? `${item_.modelName}_Anim.bin` : undefined,
        animationId: item_.animated ? 0 : undefined,
    };
}

function getArtifactModelSpec(artifact: MPHArtifactEntity): MPHEntityModelSpec {
    assert(artifact.artifactId < 8);
    const modelNumber = String(artifact.artifactId + 1).padStart(2, '0');
    return {
        modelFilename: `Artifact${modelNumber}_mdl_Model.bin`,
        animationFilename: 'Artifact_Anim.bin',
        sharedTextureFilename: 'ArtifactTextureShare_img_Model.bin',
        animationId: 0,
    };
}

const jumpPadModelNames = [
    'JumpPad', 'JumpPad_Alimbic', 'JumpPad_Ice', 'JumpPad_IceStation',
    'JumpPad_Lava', 'JumpPad_Station',
] as const;

function getJumpPadModelSpec(jumpPad: MPHJumpPadEntity): MPHEntityModelSpec {
    const name = assertExists(jumpPadModelNames[jumpPad.modelId], `jump pad model ${jumpPad.modelId}`);
    return { modelFilename: `${name}_Model.bin` };
}

function getJumpPadBeamModelSpec(jumpPad: MPHJumpPadEntity): MPHEntityModelSpec {
    assert(jumpPad.beamModelId === 0);
    return {
        modelFilename: 'JumpPad_Beam_Model.bin',
        animationFilename: 'JumpPad_Beam_Anim.bin',
        animationId: 0,
    };
}

function getFlagBaseModelSpec(flagBase: MPHFlagBaseEntity, captureTheFlag: boolean): MPHEntityModelSpec {
    assert(flagBase.teamId === 0 || flagBase.teamId === 1);
    if (captureTheFlag) {
        return {
            modelFilename: 'flagbase_ctf_mdl_Model.bin',
            animationFilename: 'flagbase_ctf_Anim.bin',
            sharedTextureFilename: flagBase.teamId === 0 ? 'flagbase_ctf_orange_img_Model.bin' : 'flagbase_ctf_green_img_Model.bin',
            animationId: 0,
        };
    }
    return {
        modelFilename: 'flagbase_bounty_Model.bin',
        animationFilename: 'flagbase_bounty_Anim.bin',
        animationId: 0,
    };
}

function getOctolithFlagModelSpec(flag: MPHOctolithFlagEntity): MPHEntityModelSpec {
    assert(flag.teamId === 0 || flag.teamId === 1);
    return {
        modelFilename: 'octolith_ctf_mdl_Model.bin',
        animationFilename: 'octolith_ctf_Anim.bin',
        sharedTextureFilename: flag.teamId === 0 ? 'octolith_ctf_orange_img_Model.bin' : 'octolith_ctf_green_img_Model.bin',
        animationId: 0,
    };
}

function getTeleporterModelSpec(sceneMode: MPHSceneMode): MPHEntityModelSpec {
    const name = sceneMode.kind === 'multiplayer' ? 'TeleporterMP' : 'Teleporter_mdl';
    return {
        modelFilename: `${name}_Model.bin`,
        animationFilename: `${name}_Anim.bin`,
        sharedTextureFilename: sceneMode.kind === 'multiplayer' ? undefined : 'TeleporterTextureShare_img_Model.bin',
        animationId: 1,
    };
}

// RenderForceFieldEntity @ 0x02168B70 maps subtypes through this palette table.
const forceFieldPaletteIds = [0, 1, 2, 7, 6, 3, 4, 5] as const;

const forceFieldModelSpec: MPHEntityModelSpec = {
    modelFilename: 'ForceField_Model.bin',
    animationFilename: 'ForceField_Anim.bin',
    paletteFilename: 'AlimbicPalettes_pal_Model.bin',
    animationId: 0,
};

function getForceFieldModelSpec(forceField: MPHForceFieldEntity): MPHEntityModelSpec {
    return {
        ...forceFieldModelSpec,
        paletteOverrides: [{ target: 0, source: forceFieldPaletteIds[forceField.subtype] ?? 0 }],
    };
}

function getDoorModelSpec(metadata: MPHEntityMetadata, door: MPHDoorEntity): MPHEntityModelSpec {
    const door_ = assertExists(metadata.doors[door.doorType], `door type ${door.doorType}`);
    let paletteOverrides: { target: number; source: number }[] | undefined;
    if (door.doorType === 0 || door.doorType === 3) {
        const paletteId = assertExists(metadata.doorLockPaletteIds[door.subtype], `door lock subtype ${door.subtype}`);
        paletteOverrides = [{ target: 1, source: paletteId }];
        if (door.doorType === 3)
            paletteOverrides.push({ target: 2, source: paletteId });
    }
    return {
        modelFilename: `${door_.modelName}_Model.bin`,
        animationFilename: `${door_.animationName}_Anim.bin`,
        sharedTextureFilename: getSharedTextureFilename(door_.modelName),
        paletteFilename: paletteOverrides !== undefined ? 'AlimbicPalettes_pal_Model.bin' : undefined,
        paletteOverrides,
        animationId: 0,
    };
}

function createSamusShipExhaustRenderers(device: GfxDevice, cache: MPHEntityResourceCache, renderCache: GfxRenderCache, shipRenderer: MPHRenderer, attachmentNodeName: string, baseOptions: MPHRendererOptions, movers: ((timeInMilliseconds: number) => void)[]): MPHRenderer[] {
    const modelFile = assertExists(cache.getFileData('particles_Model.bin'));
    const textureFile = assertExists(cache.getFileData('models/particles_Tex.bin'));
    const model = parseMPH_Model(modelFile);
    // Models store particle descriptors. Pixel/palette data is in particles_Tex.bin
    const texture = parseTEX0Texture(textureFile, model.mphTex);
    const attachmentMatrix = mat4.create();
    const particleScale = vec3.create();
    const particleOffset = vec3.create();
    const renderers: MPHRenderer[] = [];
    const spawnInterval = 1000 / 15;
    const lifetime = 250;
    const particlesPerNozzle = Math.ceil(lifetime / spawnInterval);
    for (let i = 0; i < particlesPerNozzle; i++) {
        // Stable randomization across respawns
        const angle = i * 2.399963229728653 + attachmentNodeName.length;
        const radialX = Math.cos(angle) * 0.125;
        const radialY = Math.sin(angle) * 0.125;
        const renderer = new MPHRenderer(device, renderCache, model, texture, null, {
            ...baseOptions,
            sceneTransform: undefined,
            entityModel: true,
            nodeFilter: (name) => name === 'Flame',
            forceBillboard: true,
            forceTwoSided: true,
        });
        renderers.push(renderer);
        movers.push((time) => {
            const dst = renderer.modelMatrix;
            const nodeMatrix = shipRenderer.getNodeModelMatrix(attachmentNodeName);
            if (nodeMatrix === null) {
                mat4.identity(dst);
                return;
            }
            const ageMs = (time + i * spawnInterval) % (spawnInterval * particlesPerNozzle);
            const age = ageMs / lifetime;
            vec3.set(particleOffset, radialX * age, radialY * age, 0x1800 / 0x1000 + age);
            mat4.translate(attachmentMatrix, nodeMatrix, particleOffset);
            mat4.copy(dst, attachmentMatrix);
            // Particles expand until 0x385 and shrink after 0xE1C
            const envelope = age >= 1 ? 0 :
                age < 0x385 / 0x1000 ? age / (0x385 / 0x1000) :
                age < 0xE1C / 0x1000 ? 1 :
                (1 - age) / (1 - 0xE1C / 0x1000);
            const scale = 0.5 * Math.max(0, envelope);
            vec3.set(particleScale, scale, scale, scale);
            mat4.scale(dst, dst, particleScale);
        });
    }
    return renderers;
}

function requestEntityModel(cache: MPHEntityResourceCache, spec: MPHEntityModelSpec): void {
    cache.fetchMPFile(`models/${spec.modelFilename}`);
    if (spec.animationFilename !== undefined)
        cache.fetchMPFile(`models/${spec.animationFilename}`);
    if (spec.sharedTextureFilename !== undefined)
        cache.fetchMPFile(`models/${spec.sharedTextureFilename}`);
    if (spec.paletteFilename !== undefined)
        cache.fetchMPFile(`models/${spec.paletteFilename}`);
}

interface MPHSharedTexture {
    file: ArrayBufferSlice;
    bin: MPHbin;
}

function createEntityModelRenderer(device: GfxDevice, cache: MPHEntityResourceCache, renderCache: GfxRenderCache, spec: MPHEntityModelSpec, options: MPHRendererOptions | ((animation: MPHAnimation | null) => MPHRendererOptions)): MPHRenderer {
    const modelFile = assertExists(cache.getFileData(`models/${spec.modelFilename}`));
    let shared: MPHSharedTexture | null = null;
    if (spec.sharedTextureFilename !== undefined) {
        const file = assertExists(cache.getFileData(`models/${spec.sharedTextureFilename}`));
        shared = { file, bin: parseMPH_Model(file) };
    }

    const model = parseMPH_Model(modelFile, shared?.bin.mphTex ?? null);
    let texture: TEX0;
    if (model.tex0 !== null)
        texture = model.tex0;
    else if (model.mphTex.texs.length === 0 && shared !== null)
        texture = parseTEX0Texture(shared.file, shared.bin.mphTex);
    else
        texture = parseTEX0Texture(modelFile, model.mphTex);

    if (spec.paletteFilename !== undefined) {
        const paletteFile = assertExists(cache.getFileData(`models/${spec.paletteFilename}`));
        const paletteTexture = parseTEX0Texture(paletteFile, parseMPH_Model(paletteFile).mphTex);
        for (const override of spec.paletteOverrides ?? [])
            texture.palettes[override.target] = { ...assertExists(paletteTexture.palettes[override.source]), name: `pallet_${override.target}` };
    }
    const animationFile = spec.animationFilename !== undefined ?
        cache.getFileData(`models/${spec.animationFilename}`) : null;
    const animation = animationFile !== null && spec.animationId !== undefined ?
        parseMPHAnimation(animationFile, spec.animationId, model.nodes.length) : null;
    const rendererOptions = typeof options === 'function' ? options(animation) : options;
    return new MPHRenderer(device, renderCache, model, texture, animation, { entityModel: true, ...rendererOptions });
}

const scratchPosition = vec3.create();
const scratchRotation = quat.create();
const scratchScale = vec3.create();

function calcOrientedModelMatrix(dst: mat4, position: ReadonlyVec3, facing: ReadonlyVec3, up: ReadonlyVec3, modelScale: number): void {
    const target = vec3.sub(vec3.create(), position, facing);
    mat4.targetTo(dst, position, target, up);
    mat4.scale(dst, dst, [modelScale, modelScale, modelScale]);
}

interface MPHPlatformPathStep {
    fromIndex: number;
    toIndex: number;
    durationInFrames: number;
}

interface MPHPlatformPath {
    steps: MPHPlatformPathStep[];
    cycleFrames: number;
    // Non-looping platforms hold their final keys.
    looping: boolean;
    phaseOffsetFrames: number;
}

type MPHPlatformPathSource = Omit<MPHPlatformEntity, 'path'>;

function segmentDuration(a: ReadonlyVec3, b: ReadonlyVec3, speed: number): number {
    return speed > 0 ? vec3.distance(a, b) / speed : 0;
}

// Alinos landing site lava rocks sink on player step. Simulate random sinking
// to make the viewer more interesting.
function calcPreviewPhaseFrames(platform: MPHPlatformPathSource, cycleFrames: number): number {
    const isInactiveLavaRock = !platform.active && platform.modelId >= 24 && platform.modelId <= 28;
    if (!isInactiveLavaRock || cycleFrames === 0)
        return 0;
    return (platform.entityId * 17 % 31) / 31 * cycleFrames;
}

function buildPlatformPath(platform: MPHPlatformPathSource): MPHPlatformPath {
    const { positions, delay, forwardSpeed, backwardSpeed } = platform;
    const steps: MPHPlatformPathStep[] = [];
    // Don't divide by zero on zero-delay platforms.
    const addStep = (fromIndex: number, toIndex: number, durationInFrames: number): void => {
        if (durationInFrames > 0)
            steps.push({ fromIndex, toIndex, durationInFrames });
    };
    const addMove = (fromIndex: number, toIndex: number, speed: number): void =>
        addStep(fromIndex, toIndex, segmentDuration(positions[fromIndex], positions[toIndex], speed));

    if (platform.reverseType === 2) {
        // Follow path once.
        for (let i = 0; i < positions.length - 1; i++) {
            addStep(i, i, delay);
            addMove(i, i + 1, forwardSpeed);
        }
    } else if (platform.reverseType === 1) {
        // Loop from last to first.
        for (let i = 0; i < positions.length; i++) {
            addStep(i, i, delay);
            addMove(i, (i + 1) % positions.length, forwardSpeed);
        }
    } else {
        // Alternate between endpoints.
        const last = positions.length - 1;
        addStep(0, 0, delay);
        for (let i = 0; i < last; i++)
            addMove(i, i + 1, forwardSpeed);
        addStep(last, last, delay);
        for (let i = last; i > 0; i--)
            addMove(i, i - 1, backwardSpeed);
    }

    let cycleFrames = 0;
    for (let i = 0; i < steps.length; i++)
        cycleFrames += steps[i].durationInFrames;
    const phaseOffsetFrames = calcPreviewPhaseFrames(platform, cycleFrames);
    return { steps, cycleFrames, looping: platform.reverseType !== 2, phaseOffsetFrames };
}

function setPlatformKey(dstPosition: vec3, dstRotation: quat, platform: MPHPlatformEntity, index: number): void {
    vec3.copy(dstPosition, platform.positions[index]);
    quat.copy(dstRotation, platform.rotations[index]);
}

function samplePlatformPath(dstPosition: vec3, dstRotation: quat, platform: MPHPlatformEntity, timeInMilliseconds: number): void {
    if (platform.positions.length === 0) {
        vec3.copy(dstPosition, platform.position);
        quat.identity(dstRotation);
        return;
    }

    const path = platform.path;
    if (path.cycleFrames === 0) {
        setPlatformKey(dstPosition, dstRotation, platform, 0);
        return;
    }

    const frameTime = timeInMilliseconds * 30 / 1000;
    let frame = path.looping ?
        (frameTime + path.phaseOffsetFrames) % path.cycleFrames :
        platform.active ? frameTime : 0;

    for (let i = 0; i < path.steps.length; i++) {
        const step = path.steps[i];
        if (frame <= step.durationInFrames) {
            const t = frame / step.durationInFrames;
            vec3.lerp(dstPosition, platform.positions[step.fromIndex], platform.positions[step.toIndex], t);
            quat.slerp(dstRotation, platform.rotations[step.fromIndex], platform.rotations[step.toIndex], t);
            return;
        }
        frame -= step.durationInFrames;
    }

    setPlatformKey(dstPosition, dstRotation, platform, path.looping ? 0 : platform.positions.length - 1);
}

function setupPlatformModelMatrix(dst: mat4, platform: MPHPlatformEntity, modelScale: number): void {
    if (platform.positions.length === 0) {
        const position = vec3.add(vec3.create(), platform.position, platform.positionOffset);
        calcOrientedModelMatrix(dst, position, platform.facing, platform.up, modelScale);
        return;
    }

    const position = vec3.add(vec3.create(), platform.positions[0], platform.positionOffset);
    mat4.fromRotationTranslationScale(dst, platform.rotations[0], position, [modelScale, modelScale, modelScale]);
}

function calcPlatformModelMatrix(dst: mat4, platform: MPHPlatformEntity, timeInMilliseconds: number, modelScale: number): void {
    samplePlatformPath(scratchPosition, scratchRotation, platform, timeInMilliseconds);
    vec3.add(scratchPosition, scratchPosition, platform.positionOffset);
    vec3.set(scratchScale, modelScale, modelScale, modelScale);
    mat4.fromRotationTranslationScale(dst, scratchRotation, scratchPosition, scratchScale);
}

// Stagger spawning to avoid synchronized bobs.
const ITEM_SPAWN_PREVIEW_PHASE_STEP = 0x2000;

const ARTIFACT_MODEL_OFFSET = (0x1800 - 1843) / 0x1000;

function calcArtifactModelMatrix(dst: mat4, artifact: MPHArtifactEntity, modelScale: number): void {
    const position = vec3.clone(artifact.position);
    position[1] += ARTIFACT_MODEL_OFFSET;
    calcOrientedModelMatrix(dst, position, artifact.facing, artifact.up, modelScale);
}

function calcJumpPadModelMatrix(dst: mat4, jumpPad: MPHJumpPadEntity, modelScale: number): void {
    calcOrientedModelMatrix(dst, jumpPad.position, jumpPad.facing, jumpPad.up, modelScale);
}

function calcJumpPadBeamModelMatrix(dst: mat4, jumpPad: MPHJumpPadEntity, modelScale: number): void {
    // CalculateJumpPadBeamTransform @ 0x0210CA1C rotates the launch direction
    // through the pad basis and starts the beam one game unit above the pad.
    const basis = mat4.create();
    calcOrientedModelMatrix(basis, vec3.create(), jumpPad.facing, jumpPad.up, 1);
    const direction = vec3.transformMat4(vec3.create(), jumpPad.launchDirection, basis);
    vec3.normalize(direction, direction);
    const position = vec3.scaleAndAdd(vec3.create(), jumpPad.position, jumpPad.up, 1);
    calcOrientedModelMatrix(dst, position, direction, jumpPad.facing, modelScale);
}

function calcFlagBaseModelMatrix(dst: mat4, flagBase: MPHFlagBaseEntity, modelScale: number): void {
    calcOrientedModelMatrix(dst, flagBase.position, flagBase.facing, flagBase.up, modelScale);
}

function calcOctolithFlagModelMatrix(dst: mat4, flag: MPHOctolithFlagEntity, modelScale: number): void {
    const position = vec3.scaleAndAdd(vec3.create(), flag.position, flag.up, 2);
    calcOrientedModelMatrix(dst, position, flag.facing, flag.up, modelScale);
}

function calcTeleporterModelMatrix(dst: mat4, teleporter: MPHTeleporterEntity, modelScale: number): void {
    calcOrientedModelMatrix(dst, teleporter.position, teleporter.facing, teleporter.up, modelScale);
}

function calcForceFieldModelMatrix(dst: mat4, forceField: MPHForceFieldEntity, modelScale: number): void {
    const target = vec3.sub(vec3.create(), forceField.position, forceField.facing);
    mat4.targetTo(dst, forceField.position, target, forceField.up);
    mat4.scale(dst, dst, [modelScale * forceField.width, modelScale * forceField.height, modelScale]);
}

function calcItemSpawnModelMatrix(dst: mat4, item: MPHItemSpawnEntity, phaseAngle: number, timeInMilliseconds: number, modelScale: number): void {
    const baseY = item.position[1] + 2662 / 0x1000;
    // UpdateItemInstance advances rotation by 0x300 angle units per tick and
    // uses the same phase for a 0x200-FX32 vertical bob.
    const ticks = timeInMilliseconds * 30 / 1000;
    const angle = fxAngle(phaseAngle + ticks * 0x300);
    const bob = Math.sin(angle) * (0x200 / 0x1000);
    mat4.fromYRotation(dst, angle);
    dst[12] = item.position[0];
    dst[13] = baseY + bob;
    dst[14] = item.position[2];
    vec3.set(scratchScale, modelScale, modelScale, modelScale);
    mat4.scale(dst, dst, scratchScale);
}

// Max door animation length is 2s, 6s lets us cycle open/hold/close for both
// doors across a connector without enabling visibility through.
const DOOR_OPEN_HOLD_DURATION = 2000;
const DOOR_HALF_CYCLE_DURATION = 6050;

function getAnimationLoopDuration(animation: MPHAnimation | null): number {
    const frameCount = animation?.node?.frameCount ?? animation?.texCoord?.frameCount ?? 1;
    return Math.max(1, frameCount - 1) * 1000 / 30;
}

export class MPHEntityFile {
    private movers: ((timeInMilliseconds: number) => void)[] = [];

    constructor(private entities: MPHEntities, private metadata: MPHEntityMetadata, private cache: MPHEntityResourceCache, private sceneMode: MPHSceneMode, private entityFilename: string) {
    }

    public get doors(): readonly MPHDoorEntity[] {
        return this.entities.doors;
    }

    public get teleporters(): readonly MPHTeleporterEntity[] {
        return this.entities.teleporters;
    }

    public requestResources(): void {
        for (const platform of this.entities.platforms) {
            const spec = getPlatformModelSpec(this.metadata, platform);
            if (spec !== null)
                requestEntityModel(this.cache, spec);
        }
        if (this.entities.platforms.some((platform) => platform.modelId === 23 || platform.modelId === 44)) {
            this.cache.fetchMPHARC('archives/effectsBase.arc');
            this.cache.fetchMPFile('models/particles_Tex.bin');
        }
        for (const object of this.entities.objects) {
            const spec = getObjectModelSpec(this.metadata, object);
            if (spec !== null)
                requestEntityModel(this.cache, spec);
        }
        for (const door of this.entities.doors)
            requestEntityModel(this.cache, getDoorModelSpec(this.metadata, door));
        for (const item of this.entities.itemSpawns)
            requestEntityModel(this.cache, getItemModelSpec(this.metadata, item));
        for (const artifact of this.entities.artifacts) {
            if (!artifact.active)
                continue;
            requestEntityModel(this.cache, getArtifactModelSpec(artifact));
        }
        for (const jumpPad of this.entities.jumpPads) {
            requestEntityModel(this.cache, getJumpPadModelSpec(jumpPad));
            if (jumpPad.active)
                requestEntityModel(this.cache, getJumpPadBeamModelSpec(jumpPad));
        }
        const captureTheFlag = this.sceneMode.kind === 'multiplayer' && this.sceneMode.captureTheFlag === true;
        for (const flagBase of this.entities.flagBases) {
            if (!flagBase.active)
                continue;
            requestEntityModel(this.cache, getFlagBaseModelSpec(flagBase, captureTheFlag));
        }
        for (const flag of this.entities.octolithFlags)
            requestEntityModel(this.cache, getOctolithFlagModelSpec(flag));
        if (this.entities.teleporters.some((teleporter) => !teleporter.invisible))
            requestEntityModel(this.cache, getTeleporterModelSpec(this.sceneMode));
        if (this.entities.forceFields.some((forceField) => forceField.active))
            requestEntityModel(this.cache, forceFieldModelSpec);
    }

    public createRenderers(device: GfxDevice, renderCache: GfxRenderCache, lighting: MPHLighting, fog: MPHFogConfig | null, sceneTransform?: mat4, staggerDoorCycles: boolean = false): { renderers: MPHRenderer[], doorRenderers: Map<number, MPHRenderer> } {
        const renderers: MPHRenderer[] = [];
        const doorRenderers = new Map<number, MPHRenderer>();
        const baseOptions: MPHRendererOptions = { sceneMode: this.sceneMode, lighting, fog, sceneTransform };
        const normalizedEntityFilename = normalizeEntityFilename(this.entityFilename);
        for (const platform of this.entities.platforms) {
            const spec = getPlatformModelSpec(this.metadata, platform);
            if (spec === null)
                continue;
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, spec, baseOptions);
            if (platform.positions.length > 1)
                this.movers.push((time) => calcPlatformModelMatrix(renderer.modelMatrix, platform, time, renderer.modelScale));
            else
                setupPlatformModelMatrix(renderer.modelMatrix, platform, renderer.modelScale);
            renderers.push(renderer);
            if (platform.modelId === 23 || platform.modelId === 44) {
                for (const nodeName of ['R_Turret', 'R_Turret1', 'R_Turret2', 'R_Turret3'])
                    renderers.push(...createSamusShipExhaustRenderers(device, this.cache, renderCache, renderer, nodeName, baseOptions, this.movers));
            }
        }
        for (const object of this.entities.objects) {
            const spec = getObjectModelSpec(this.metadata, object);
            if (spec === null)
                continue;
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, spec, {
                ...baseOptions,
            });
            calcOrientedModelMatrix(renderer.modelMatrix, object.position, object.facing, object.up, renderer.modelScale);
            renderers.push(renderer);
        }
        for (let index = 0; index < this.entities.doors.length; index++) {
            const door = this.entities.doors[index];
            const spec = getDoorModelSpec(this.metadata, door);
            const doorRenderer = createEntityModelRenderer(device, this.cache, renderCache, spec, (animation) => {
                const animationDuration = Math.max(0, (animation?.node?.frameCount ?? 1) - 1) * 1000 / 30;
                const cycleOffset = staggerDoorCycles && door.connectionId !== 0xFF && door.destinationEntityFilename !== '' ?
                    (normalizedEntityFilename > door.destinationEntityFilename ? DOOR_HALF_CYCLE_DURATION : 0) :
                    (index & 1) * DOOR_HALF_CYCLE_DURATION;
                return {
                    sceneMode: this.sceneMode,
                    fog,
                    sceneTransform,
                    mapAnimationTime: (time) => {
                        let phase = (time + cycleOffset) % (DOOR_HALF_CYCLE_DURATION * 2);
                        if (phase < DOOR_OPEN_HOLD_DURATION)
                            return animationDuration;
                        phase -= DOOR_OPEN_HOLD_DURATION;
                        if (phase < animationDuration)
                            return animationDuration - phase;
                        if (phase < DOOR_HALF_CYCLE_DURATION)
                            return 0;
                        phase -= DOOR_HALF_CYCLE_DURATION;
                        if (phase < animationDuration)
                            return phase;
                        return animationDuration;
                    },
                };
            });
            calcOrientedModelMatrix(doorRenderer.modelMatrix, door.position, door.facing, door.up, doorRenderer.modelScale);
            renderers.push(doorRenderer);
            doorRenderers.set(door.entityId, doorRenderer);
        }
        for (let index = 0; index < this.entities.itemSpawns.length; index++) {
            const item = this.entities.itemSpawns[index];
            const phaseAngle = index * ITEM_SPAWN_PREVIEW_PHASE_STEP;
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, getItemModelSpec(this.metadata, item), {
                ...baseOptions,
            });
            this.movers.push((time) => calcItemSpawnModelMatrix(renderer.modelMatrix, item, phaseAngle, time, renderer.modelScale));
            renderers.push(renderer);
        }
        for (const artifact of this.entities.artifacts) {
            if (!artifact.active)
                continue;
            const colors: [vec3, vec3] = [vec3.clone(lighting.colors[0]), vec3.clone(lighting.colors[1])];
            const directions: [vec3, vec3] = [vec3.clone(lighting.directions[0]), vec3.clone(lighting.directions[1])];
            for (const light of this.entities.lightSources) {
                if (!pointInsideLightSource(light, artifact.position))
                    continue;
                if (light.light0Enabled) {
                    vec3.scale(colors[0], light.light0Color, 1 / 31);
                    vec3.negate(directions[0], light.light0Direction);
                }
                if (light.light1Enabled) {
                    vec3.scale(colors[1], light.light1Color, 1 / 31);
                    vec3.negate(directions[1], light.light1Direction);
                }
            }
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, getArtifactModelSpec(artifact), (animation) => {
                const duration = getAnimationLoopDuration(animation);
                return {
                    ...baseOptions,
                    lighting: { colors, directions },
                    mapAnimationTime: (time) => time % duration,
                };
            });
            calcArtifactModelMatrix(renderer.modelMatrix, artifact, renderer.modelScale);
            renderers.push(renderer);
        }
        for (const jumpPad of this.entities.jumpPads) {
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, getJumpPadModelSpec(jumpPad), {
                ...baseOptions,
            });
            calcJumpPadModelMatrix(renderer.modelMatrix, jumpPad, renderer.modelScale);
            renderers.push(renderer);
            if (!jumpPad.active)
                continue;
            const beamRenderer = createEntityModelRenderer(device, this.cache, renderCache, getJumpPadBeamModelSpec(jumpPad), {
                ...baseOptions,
            });
            calcJumpPadBeamModelMatrix(beamRenderer.modelMatrix, jumpPad, beamRenderer.modelScale);
            renderers.push(beamRenderer);
        }
        const captureTheFlag = this.sceneMode.kind === 'multiplayer' && this.sceneMode.captureTheFlag === true;
        for (const flagBase of this.entities.flagBases) {
            if (!flagBase.active)
                continue;
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, getFlagBaseModelSpec(flagBase, captureTheFlag), (animation) => {
                const duration = getAnimationLoopDuration(animation);
                return {
                    ...baseOptions,
                    mapAnimationTime: (time) => time % duration,
                };
            });
            calcFlagBaseModelMatrix(renderer.modelMatrix, flagBase, renderer.modelScale);
            renderers.push(renderer);
        }
        for (const flag of this.entities.octolithFlags) {
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, getOctolithFlagModelSpec(flag), (animation) => {
                const duration = getAnimationLoopDuration(animation);
                return {
                    ...baseOptions,
                    mapAnimationTime: (time) => time % duration,
                };
            });
            calcOctolithFlagModelMatrix(renderer.modelMatrix, flag, renderer.modelScale);
            renderers.push(renderer);
        }
        for (const teleporter of this.entities.teleporters) {
            if (teleporter.invisible)
                continue;
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, getTeleporterModelSpec(this.sceneMode), (animation) => {
                const duration = getAnimationLoopDuration(animation);
                return {
                    ...baseOptions,
                    mapAnimationTime: (time) => time % duration,
                };
            });
            calcTeleporterModelMatrix(renderer.modelMatrix, teleporter, renderer.modelScale);
            renderers.push(renderer);
        }
        for (const forceField of this.entities.forceFields) {
            if (!forceField.active)
                continue;
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, getForceFieldModelSpec(forceField), (animation) => {
                const duration = getAnimationLoopDuration(animation);
                return {
                    ...baseOptions,
                    mapAnimationTime: (time) => time % duration,
                };
            });
            calcForceFieldModelMatrix(renderer.modelMatrix, forceField, renderer.modelScale);
            renderers.push(renderer);
        }
        return { renderers, doorRenderers };
    }

    public update(timeInMilliseconds: number): void {
        for (let i = 0; i < this.movers.length; i++)
            this.movers[i](timeInMilliseconds);
    }
}
