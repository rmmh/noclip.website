import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { mat4, quat, ReadonlyQuat, ReadonlyVec3, vec3 } from 'gl-matrix';
import { assert, assertExists, readString } from '../util.js';
import { GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { fx32, TEX0 } from '../nns_g3d/NNS_G3D.js';
import { MPHAnimation, parseMPHAnimation } from './mph_anim.js';
import { fxAngle, MPHbin, parseMPH_Model, parseTEX0Texture } from './mph_binModel.js';
import { MPHFogConfig, MPHLighting, MPHRenderer, MPHRendererOptions, MPHSceneMode } from './render.js';
import { ENTITY_TYPE_ENEMY_SPAWN, getEnemyAnimationPhaseMilliseconds, getEnemyModelSpecs, isWaspEnemy, MPHEnemySpawnEntity, parseEnemySpawn, sampleEnemyPose, MPHGameplayRandom, SurfaceCrawlerSimulation, sampleBlastcapAnimation, sampleMochtroidType03Animation, MPHEnemySimulation, sampleMochtroidType06Animation, samplePsychoBitAnimation, sampleSphinkTickAnimation, sampleDripStankAnimation, sampleGuardBot1Animation, GuardBotSimulation, sampleGuardBot2Animation, sampleAlimbicStatueAnimation, sampleLavaDemonAnimation, sampleBigEyeTurretAnimation, sampleBigEyeBossAnimation, sampleCylinderBossEyeAnimation, sampleShriekbatAnimation, MochtroidRoamingSimulation, sampleMochtroidType05Animation, sampleMochtroidType04Animation, sampleWarWaspAnimation, sampleGorea2Animation, sampleGorea1AAnimation, sampleBarbedWarWaspAnimation, sampleGeemerAnimation, sampleCylinderBossAnimation, sampleAlimbicTurretAim } from './enemy.js';
import { evaluateParticleScalar, evaluateParticleVector, MPHParticleEmitter, parseMPHParticleSystem } from './mph_particle.js';
import { MPHCollisionData } from './mph_collision.js';

const ENTITY_HEADER_SIZE = 0x24;
const ENTITY_ENTRY_SIZE = 0x18;
const ENTITY_TYPE_PLATFORM = 0;
const ENTITY_TYPE_OBJECT = 1;
const ENTITY_TYPE_DOOR = 3;
const ENTITY_TYPE_ITEM_SPAWN = 4;
const ENTITY_TYPE_TRIGGER_VOLUME = 7;
const ENTITY_TYPE_JUMP_PAD = 9;
const ENTITY_TYPE_OCTOLITH_FLAG = 12;
const ENTITY_TYPE_FLAG_BASE = 13;
const ENTITY_TYPE_TELEPORTER = 14;
const ENTITY_TYPE_NODE_DEFENSE = 15;
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
const NODE_DEFENSE_DATA_SIZE = 0x68;
const LIGHT_SOURCE_DATA_SIZE = 0x88;
const ARTIFACT_DATA_SIZE = 0x46;
const FORCE_FIELD_DATA_SIZE = 0x35;
const TRIGGER_VOLUME_DATA_SIZE = 0xA0;

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
    showBase: boolean;
    respawns: boolean;
    maxSpawnCount: number;
    respawnDelayTicks: number;
    initialDelayTicks: number;
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

interface MPHNodeDefenseEntity extends MPHEntityEntry {
    position: vec3;
    up: vec3;
    facing: vec3;
    radius: number;
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

type MPHTriggerVolume = MPHLightVolume;

interface MPHTriggerVolumeEntity extends MPHEntityEntry {
    mode: number;
    initialState: number;
    counter: number;
    volume: MPHTriggerVolume;
    targetEntityIds: readonly [number, number];
    messages: readonly [number, number];
    messageParams: readonly [number, number];
}

export interface MPHEntities {
    platforms: MPHPlatformEntity[];
    objects: MPHObjectEntity[];
    doors: MPHDoorEntity[];
    itemSpawns: MPHItemSpawnEntity[];
    enemySpawns: MPHEnemySpawnEntity[];
    jumpPads: MPHJumpPadEntity[];
    octolithFlags: MPHOctolithFlagEntity[];
    flagBases: MPHFlagBaseEntity[];
    nodeDefenses: MPHNodeDefenseEntity[];
    lightSources: MPHLightSourceEntity[];
    artifacts: MPHArtifactEntity[];
    teleporters: MPHTeleporterEntity[];
    forceFields: MPHForceFieldEntity[];
    triggerVolumes: MPHTriggerVolumeEntity[];
}

interface MPHEntityModelSpec {
    modelFilename: string;
    modelDirectory?: string;
    animationFilename?: string;
    sharedTextureFilename?: string;
    paletteFilename?: string;
    paletteOverrides?: readonly { target: number; source: number }[];
    animationId?: number;
    additionalAnimationIds?: number[];
    additionalTexCoordAnimationIds?: number[];
    additionalMaterialAnimationIds?: (number | null)[];
    texCoordAnimationId?: number;
    animationLoop?: boolean;
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
        showBase: view.getUint8(offs + 0x31) !== 0,
        respawns: view.getUint8(offs + 0x32) !== 0,
        maxSpawnCount: view.getUint16(offs + 0x34, true),
        respawnDelayTicks: view.getUint16(offs + 0x36, true),
        initialDelayTicks: view.getUint16(offs + 0x38, true),
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

function parseNodeDefense(entry: MPHEntityEntry, view: DataView): MPHNodeDefenseEntity {
    assert(entry.dataLength === NODE_DEFENSE_DATA_SIZE);
    const offs = entry.dataOffset;
    return {
        ...entry,
        position: readVec3Fx(view, offs + 0x04),
        up: readVec3Fx(view, offs + 0x10),
        facing: readVec3Fx(view, offs + 0x1C),
        // RenderNodeDefenseEntity @ 0x0212E4A4 uses runtime +0x60,
        // copied directly from the authored record.
        radius: readFx32(view, offs + 0x44),
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

function pointInsideVolume(volume: MPHLightVolume, point: vec3): boolean {
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

function parseTriggerVolume(entry: MPHEntityEntry, view: DataView): MPHTriggerVolumeEntity {
    assert(entry.dataLength === TRIGGER_VOLUME_DATA_SIZE);
    const offs = entry.dataOffset;
    const position = readVec3Fx(view, offs + 0x04);
    const volumeType = view.getUint32(offs + 0x2C, true);
    let volume: MPHTriggerVolume;
    if (volumeType === 0) {
        volume = {
            kind: 'box',
            axes: [
                readVec3Fx(view, offs + 0x30),
                readVec3Fx(view, offs + 0x3C),
                readVec3Fx(view, offs + 0x48),
            ],
            origin: readVec3Fx(view, offs + 0x54),
            extents: readVec3Fx(view, offs + 0x60),
        };
    } else if (volumeType === 1) {
        volume = {
            kind: 'cylinder',
            axis: readVec3Fx(view, offs + 0x30),
            origin: readVec3Fx(view, offs + 0x3C),
            radius: readFx32(view, offs + 0x4C),
            length: readFx32(view, offs + 0x50),
        };
    } else {
        assert(volumeType === 2);
        volume = {
            kind: 'sphere',
            origin: readVec3Fx(view, offs + 0x30),
            radius: readFx32(view, offs + 0x3C),
        };
    }
    // CreateTriggerVolumeEntity @ 0x0210AFE8 applies the entity position
    // after copying the authored volume.
    vec3.add(volume.origin, volume.origin, position);
    return {
        ...entry,
        mode: view.getUint32(offs + 0x28, true),
        initialState: view.getUint8(offs + 0x6E),
        counter: view.getUint32(offs + 0x7C, true),
        volume,
        targetEntityIds: [
            view.getInt16(offs + 0x80, true),
            view.getInt16(offs + 0x90, true),
        ],
        messages: [
            view.getUint32(offs + 0x84, true),
            view.getUint32(offs + 0x94, true),
        ],
        messageParams: [
            view.getUint32(offs + 0x88, true),
            view.getUint32(offs + 0x98, true),
        ],
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
    const enemySpawns: MPHEnemySpawnEntity[] = [];
    const jumpPads: MPHJumpPadEntity[] = [];
    const octolithFlags: MPHOctolithFlagEntity[] = [];
    const flagBases: MPHFlagBaseEntity[] = [];
    const nodeDefenses: MPHNodeDefenseEntity[] = [];
    const lightSources: MPHLightSourceEntity[] = [];
    const artifacts: MPHArtifactEntity[] = [];
    const teleporters: MPHTeleporterEntity[] = [];
    const forceFields: MPHForceFieldEntity[] = [];
    const triggerVolumes: MPHTriggerVolumeEntity[] = [];
    const gameplayRandom = new MPHGameplayRandom();
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
        else if (entry.type === ENTITY_TYPE_ENEMY_SPAWN)
            enemySpawns.push(parseEnemySpawn(entry, view, gameplayRandom));
        else if (entry.type === ENTITY_TYPE_JUMP_PAD)
            jumpPads.push(parseJumpPad(entry, view));
        else if (entry.type === ENTITY_TYPE_OCTOLITH_FLAG)
            octolithFlags.push(parseOctolithFlag(entry, view));
        else if (entry.type === ENTITY_TYPE_FLAG_BASE)
            flagBases.push(parseFlagBase(entry, view));
        else if (entry.type === ENTITY_TYPE_NODE_DEFENSE)
            nodeDefenses.push(parseNodeDefense(entry, view));
        else if (entry.type === ENTITY_TYPE_LIGHT_SOURCE)
            lightSources.push(parseLightSource(entry, view));
        else if (entry.type === ENTITY_TYPE_ARTIFACT)
            artifacts.push(parseArtifact(entry, view));
        else if (entry.type === ENTITY_TYPE_TELEPORTER)
            teleporters.push(parseTeleporter(entry, view, buffer));
        else if (entry.type === ENTITY_TYPE_FORCE_FIELD)
            forceFields.push(parseForceField(entry, view));
        else if (entry.type === ENTITY_TYPE_TRIGGER_VOLUME)
            triggerVolumes.push(parseTriggerVolume(entry, view));
    }

    assert(entryCount === view.getUint16(0x04 + layerId * 2, true));
    return { platforms, objects, doors, itemSpawns, enemySpawns, jumpPads, octolithFlags, flagBases, nodeDefenses, lightSources, artifacts, teleporters, forceFields, triggerVolumes };
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
    // Inactive, activation transition, active, and deactivation transition.
    animationIds: readonly [number, number, number, number];
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
    const stateAnimationId = object_.animationIds[object.initialState];
    const animationIds = [...new Set(object_.animationIds.filter((animationId) => animationId >= 0))];
    const animationId = stateAnimationId >= 0 ? stateAnimationId : animationIds[0];
    const hasAnimation = object_.animationName !== null && animationId !== undefined;
    return {
        modelFilename: `${object_.modelName}_Model.bin`,
        animationFilename: hasAnimation ? `${object_.animationName}_Anim.bin` : undefined,
        sharedTextureFilename: getSharedTextureFilename(object_.modelName),
        animationId: hasAnimation ? animationId : undefined,
        additionalAnimationIds: hasAnimation ?
            animationIds.filter((candidate) => candidate !== animationId) : undefined,
    };
}

function isPlatformModelSupported(metadata: MPHEntityMetadata, platform: MPHPlatformEntity): boolean {
    return metadata.platforms[platform.modelId] !== undefined;
}

function getPlatformModelSpec(metadata: MPHEntityMetadata, platform: MPHPlatformEntity): MPHEntityModelSpec | null {
    const platform_ = metadata.platforms[platform.modelId];
    if (platform_ === undefined || platform_.modelName === null)
        return null;
    const additionalAnimationIds = platform_.animationName === null ? undefined :
        [...new Set(platform_.animationIds.filter((animationId) => animationId >= 0 && animationId !== platform_.animationId))];
    return {
        modelFilename: `${platform_.modelName}_Model.bin`,
        animationFilename: platform_.animationName !== null ? `${platform_.animationName}_Anim.bin` : undefined,
        animationId: platform_.animationName !== null ? platform_.animationId : undefined,
        additionalAnimationIds,
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

// InitializeItemSpawnEntityResources @ 0x021074A4 loads this controller model
// from common.arc. RenderItemSpawnEntity @ 0x02106F04 draws it only when the
// ItemSpawn record's byte at +0x31 is nonzero.
const itemSpawnBaseModelSpec: MPHEntityModelSpec = {
    modelFilename: 'items_base_Model.bin',
    modelDirectory: '',
};

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

const nodeDefenseTerminalModelSpec: MPHEntityModelSpec = {
    modelFilename: 'koth_terminal_Model.bin',
};

const nodeDefenseDataFlowModelSpec: MPHEntityModelSpec = {
    modelFilename: 'koth_data_flow_Model.bin',
};

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
            forceBillboard: 'axial',
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

// UpdateParticleSystems @ 0x02112888 integrates each particle once per
// engine update using this fixed FX32 time step.
const PARTICLE_UPDATE_SECONDS = 0x88 / 0x1000;

function wrapParticleEmitterAge(age: number, emitter: MPHParticleEmitter): number {
    // UpdateParticleSystems @ 0x02112888 advances the emitter's start/end
    // clocks by wrapEnd - wrapStart when it reaches wrapEnd.
    if (emitter.wrapEnd <= emitter.wrapStart || age < emitter.wrapEnd)
        return Math.min(age, emitter.duration);
    return emitter.wrapStart + (age - emitter.wrapEnd) % (emitter.wrapEnd - emitter.wrapStart);
}

function createArtifactKeyEffectRenderers(device: GfxDevice, cache: MPHEntityResourceCache, renderCache: GfxRenderCache,
    item: MPHItemSpawnEntity, parentPlatform: MPHPlatformEntity | null, getItemTime: (time: number) => number,
    isItemVisible: NonNullable<MPHRendererOptions['isVisibleAtTime']>,
    baseOptions: MPHRendererOptions, movers: ((timeInMilliseconds: number) => void)[]): MPHRenderer[] {
    const modelFile = assertExists(cache.getFileData('particles_Model.bin'));
    const textureFile = assertExists(cache.getFileData('models/particles_Tex.bin'));
    const effectFile = assertExists(cache.getFileData('effects/artifactKeyEffect_PS.bin'));
    const model = parseMPH_Model(modelFile);
    const texture = parseTEX0Texture(textureFile, model.mphTex);
    const effect = parseMPHParticleSystem(effectFile);
    const renderers: MPHRenderer[] = [];

    for (const emitter of effect.emitters) {
        assert(emitter.velocityOverLifetime === null);
        const lifetime = evaluateParticleScalar(emitter.lifetime, 0, emitter.duration, 0);
        const particleCount = Math.ceil(lifetime / PARTICLE_UPDATE_SECONDS);
        for (let slot = 0; slot < particleCount; slot++) {
            const initialPosition = vec3.create();
            const initialVelocity = vec3.create();
            const particlePosition = vec3.create();
            const worldPosition = vec3.create();
            const particleScale = vec3.create();

            const sampleParticle = (timeInMilliseconds: number): { age: number, lifetime: number, emitterAge: number } | null => {
                const effectSeconds = getItemTime(timeInMilliseconds) / 1000 - item.initialDelayTicks / 30;
                if (effectSeconds < 0)
                    return null;
                const currentTick = Math.floor(effectSeconds / PARTICLE_UPDATE_SECONDS);
                const spawnTick = currentTick - slot;
                if (spawnTick < 0)
                    return null;
                const spawnTime = spawnTick * PARTICLE_UPDATE_SECONDS;
                const emitterAge = wrapParticleEmitterAge(spawnTime, emitter);
                const particleLifetime = evaluateParticleScalar(emitter.lifetime, 0, emitter.duration, emitterAge);
                const age = effectSeconds - spawnTime;
                return age < particleLifetime ? { age, lifetime: particleLifetime, emitterAge } : null;
            };

            const renderer = new MPHRenderer(device, renderCache, model, texture, null, {
                ...baseOptions,
                entityModel: true,
                nodeFilter: (name) => emitter.nodeNames.includes(name),
                // RenderBillboardParticleQuad @ 0x021157CC constructs this
                // type-4 quad from the full camera basis.
                forceBillboard: 'camera',
                forceTwoSided: true,
                isVisibleAtTime: (time, viewerInput) =>
                    isItemVisible(time, viewerInput) && sampleParticle(time) !== null,
                modifyMaterialColor: (dst, _materialName, time) => {
                    const sample = sampleParticle(time);
                    if (sample === null) {
                        dst.a = 0;
                        return;
                    }
                    dst.r = evaluateParticleScalar(emitter.red, sample.age, sample.lifetime, sample.emitterAge);
                    dst.g = evaluateParticleScalar(emitter.green, sample.age, sample.lifetime, sample.emitterAge);
                    dst.b = evaluateParticleScalar(emitter.blue, sample.age, sample.lifetime, sample.emitterAge);
                    dst.a = evaluateParticleScalar(emitter.alpha, sample.age, sample.lifetime, sample.emitterAge);
                },
            });
            movers.push((time) => {
                const sample = sampleParticle(time);
                if (sample === null) {
                    mat4.identity(renderer.modelMatrix);
                    return;
                }
                evaluateParticleVector(initialPosition, emitter.initialPosition, sample.emitterAge, emitter.duration, sample.emitterAge);
                evaluateParticleVector(initialVelocity, emitter.initialVelocity, sample.emitterAge, emitter.duration, sample.emitterAge);
                vec3.scaleAndAdd(particlePosition, initialPosition, initialVelocity, sample.age);

                calcItemSpawnPosition(worldPosition, item, parentPlatform, getItemTime(time));
                worldPosition[1] += fx32(2662);
                vec3.add(worldPosition, worldPosition, particlePosition);
                mat4.fromTranslation(renderer.modelMatrix, worldPosition);
                const size = evaluateParticleScalar(emitter.size, sample.age, sample.lifetime, sample.emitterAge);
                // RenderBillboardParticleQuad @ 0x021157CC treats size as
                // the full edge length. The particle templates span
                // [-1, +1], so their model scale is half that value.
                const scale = renderer.modelScale * size * 0.5;
                vec3.set(particleScale, scale, scale, scale);
                mat4.scale(renderer.modelMatrix, renderer.modelMatrix, particleScale);
            });
            renderers.push(renderer);
        }
    }
    return renderers;
}

function requestEntityModel(cache: MPHEntityResourceCache, spec: MPHEntityModelSpec): void {
    const modelDirectory = spec.modelDirectory ?? 'models';
    const modelPath = modelDirectory === '' ? spec.modelFilename : `${modelDirectory}/${spec.modelFilename}`;
    if (modelDirectory !== '')
        cache.fetchMPFile(modelPath);
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

function createEntityModelRenderer(device: GfxDevice, cache: MPHEntityResourceCache, renderCache: GfxRenderCache, spec: MPHEntityModelSpec, options: MPHRendererOptions | ((animation: MPHAnimation | null, additionalAnimations: readonly MPHAnimation[]) => MPHRendererOptions)): MPHRenderer {
    const modelDirectory = spec.modelDirectory ?? 'models';
    const modelPath = modelDirectory === '' ? spec.modelFilename : `${modelDirectory}/${spec.modelFilename}`;
    const modelFile = assertExists(cache.getFileData(modelPath));
    const sharedTextureFile = spec.sharedTextureFilename !== undefined ?
        assertExists(cache.getFileData(`models/${spec.sharedTextureFilename}`)) : null;
    const sharedTextureBin = sharedTextureFile !== null ? parseMPH_Model(sharedTextureFile) : null;
    const model = parseMPH_Model(modelFile, sharedTextureBin?.mphTex ?? null);
    const texture = model.tex0 !== null ? model.tex0 :
        model.mphTex.texs.length !== 0 ? parseTEX0Texture(modelFile, model.mphTex) :
            sharedTextureFile !== null ? parseTEX0Texture(sharedTextureFile, assertExists(sharedTextureBin).mphTex) :
                parseTEX0Texture(modelFile, model.mphTex);
    if (spec.paletteFilename !== undefined) {
        const paletteFile = assertExists(cache.getFileData(`models/${spec.paletteFilename}`));
        const paletteTexture = parseTEX0Texture(paletteFile, parseMPH_Model(paletteFile).mphTex);
        for (const override of spec.paletteOverrides ?? [])
            texture.palettes[override.target] = { ...assertExists(paletteTexture.palettes[override.source]), name: `pallet_${override.target}` };
    }
    const animationFile = spec.animationFilename !== undefined ?
        cache.getFileData(`models/${spec.animationFilename}`) : null;
    let animation = animationFile !== null && spec.animationId !== undefined ?
        parseMPHAnimation(animationFile, spec.animationId, model.nodes.length) : null;
    if (animationFile !== null && spec.texCoordAnimationId !== undefined) {
        const texCoordAnimation = parseMPHAnimation(animationFile, spec.texCoordAnimationId).texCoord;
        animation = { node: animation?.node ?? null, material: animation?.material ?? null, texCoord: texCoordAnimation };
    }
    const additionalAnimations = animationFile !== null && spec.additionalAnimationIds !== undefined ?
        spec.additionalAnimationIds.map((animationId) =>
            parseMPHAnimation(animationFile, animationId, model.nodes.length)) : [];
    const rendererOptions: MPHRendererOptions = { ...(typeof options === 'function' ? options(animation, additionalAnimations) : options) };
    if (additionalAnimations.length > 0 && rendererOptions.additionalNodeAnimations === undefined)
        rendererOptions.additionalNodeAnimations = additionalAnimations.map((animation) => animation.node);
    if (animationFile !== null && spec.additionalMaterialAnimationIds !== undefined) {
        rendererOptions.additionalMaterialAnimations = spec.additionalMaterialAnimationIds.map((animationId) =>
            animationId !== null ? assertExists(parseMPHAnimation(animationFile, animationId).material) : null);
    }
    if (animationFile !== null && spec.additionalTexCoordAnimationIds !== undefined) {
        rendererOptions.additionalTexCoordAnimations = spec.additionalTexCoordAnimationIds.map((animationId) =>
            assertExists(parseMPHAnimation(animationFile, animationId).texCoord));
    }
    return new MPHRenderer(device, renderCache, model, texture, animation, { entityModel: true, ...rendererOptions });
}

const scratchPosition = vec3.create();
const scratchItemPosition = vec3.create();
const scratchItemParentPosition = vec3.create();
const scratchItemLocalOffset = vec3.create();
const scratchDirection = vec3.create();
const scratchUp = vec3.create();
const scratchRotation = quat.create();
const scratchItemParentRotation = quat.create();
const scratchItemRotationDelta = quat.create();
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

function getPlatformActivationDelayMilliseconds(platform: MPHPlatformEntity): number {
    if (platform.active)
        return 0;
    const phaseFrames = (platform.entityId * 17 % 31) * 0.2 * 30;
    return (4 * 30 + phaseFrames) * 1000 / 30;
}

interface MPHPlatformAnimationSample {
    index: number;
    timeInAnimation: number;
}

interface MPHPlatformPlaybackState {
    active: boolean;
    previousActive: boolean;
    transitionElapsed: number;
}

function samplePlatformAnimation(platform: MPHPlatformEntity, metadata: MPHPlatformMetadata, spec: MPHEntityModelSpec,
    primaryAnimation: MPHAnimation | null, additionalAnimations: readonly MPHAnimation[], timeInMilliseconds: number,
    playbackState: MPHPlatformPlaybackState | null = null): MPHPlatformAnimationSample {
    const animationIds = metadata.animationIds;
    if (spec.additionalAnimationIds === undefined || spec.animationId === undefined)
        return { index: 0, timeInAnimation: timeInMilliseconds };

    const getAnimationIndex = (animationId: number): number => {
        if (animationId === spec.animationId)
            return 0;
        const index = assertExists(spec.additionalAnimationIds).indexOf(animationId);
        assert(index >= 0);
        return 1 + index;
    };
    const getAnimationDuration = (index: number): number => {
        const frameCount = index === 0 ? primaryAnimation?.node?.frameCount :
            additionalAnimations[index - 1]?.node?.frameCount ??
            additionalAnimations[index - 1]?.material?.frameCount;
        return Math.max(0, (frameCount ?? 1) - 1) * 1000 / 30;
    };

    if (playbackState !== null) {
        const stateAnimationId = animationIds[playbackState.active ? 2 : 0];
        if (playbackState.active === playbackState.previousActive)
            return stateAnimationId < 0 ?
                { index: 0, timeInAnimation: 0 } :
                { index: getAnimationIndex(stateAnimationId), timeInAnimation: timeInMilliseconds };

        const transitionAnimationId = animationIds[playbackState.active ? 1 : 3];
        if (transitionAnimationId >= 0) {
            const transitionIndex = getAnimationIndex(transitionAnimationId);
            const transitionDuration = getAnimationDuration(transitionIndex);
            if (playbackState.transitionElapsed < transitionDuration)
                return {
                    index: transitionIndex,
                    timeInAnimation: playbackState.transitionElapsed,
                };
            return stateAnimationId < 0 ?
                { index: 0, timeInAnimation: 0 } :
                {
                    index: getAnimationIndex(stateAnimationId),
                    timeInAnimation: playbackState.transitionElapsed - transitionDuration,
                };
        }
        return stateAnimationId < 0 ?
            { index: 0, timeInAnimation: 0 } :
            { index: getAnimationIndex(stateAnimationId), timeInAnimation: playbackState.transitionElapsed };
    }

    const elapsed = timeInMilliseconds - getPlatformActivationDelayMilliseconds(platform);
    if (elapsed < 0) {
        const inactiveAnimationId = animationIds[0];
        return inactiveAnimationId < 0 ?
            { index: 0, timeInAnimation: 0 } :
            { index: getAnimationIndex(inactiveAnimationId), timeInAnimation: timeInMilliseconds };
    }

    // SetPlatformActiveAnimation @ 0x0216F208 selects the +0x10 activation
    // clip as a one-shot. UpdatePlatformEntity @ 0x0216C4E8 replaces it with
    // the queued +0x14 active clip only after the animation reports completion.
    const activateAnimationId = animationIds[1];
    if (!platform.active && activateAnimationId >= 0) {
        const activateIndex = getAnimationIndex(activateAnimationId);
        const activateDuration = getAnimationDuration(activateIndex);
        if (elapsed < activateDuration)
            return { index: activateIndex, timeInAnimation: elapsed };
        return { index: getAnimationIndex(animationIds[2]), timeInAnimation: elapsed - activateDuration };
    }
    return { index: getAnimationIndex(animationIds[2]), timeInAnimation: elapsed };
}

function samplePlatformPath(dstPosition: vec3, dstRotation: quat, platform: MPHPlatformEntity,
        timeInMilliseconds: number, activeFrameTimeOverride: number | null = null): void {
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
    // CreatePlatformEntity @ 0x0216DB48 leaves authored inactive platforms in
    // movement state 0 until ActivatePlatformMovement @ 0x0216EF40 is called.
    // The passive viewer supplies that absent gameplay message after a
    // deterministic per-entity dwell.
    const inactiveActivationDelayFrames = getPlatformActivationDelayMilliseconds(platform) * 30 / 1000;
    const activeFrameTime = activeFrameTimeOverride ?? frameTime - inactiveActivationDelayFrames;
    if (activeFrameTime < 0) {
        setPlatformKey(dstPosition, dstRotation, platform, 0);
        return;
    }
    let frame = path.looping ?
        (activeFrameTime + path.phaseOffsetFrames) % path.cycleFrames : activeFrameTime;

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

function calcPlatformModelMatrix(dst: mat4, platform: MPHPlatformEntity, timeInMilliseconds: number,
        modelScale: number, activeFrameTimeOverride: number | null = null): void {
    samplePlatformPath(scratchPosition, scratchRotation, platform, timeInMilliseconds, activeFrameTimeOverride);
    vec3.add(scratchPosition, scratchPosition, platform.positionOffset);
    vec3.set(scratchScale, modelScale, modelScale, modelScale);
    mat4.fromRotationTranslationScale(dst, scratchRotation, scratchPosition, scratchScale);
}

// Stagger spawning to avoid synchronized bobs.
const ITEM_SPAWN_PREVIEW_PHASE_STEP = 0x2000;

function calcEnemyModelMatrix(dst: mat4, enemy: MPHEnemySpawnEntity, simulation: MPHEnemySimulation | null, timeInMilliseconds: number, modelScale: number, localYawRadians = 0): void {
    if (simulation !== null)
        simulation.sample(scratchPosition, scratchDirection, scratchUp, timeInMilliseconds);
    else {
        sampleEnemyPose(scratchPosition, scratchDirection, enemy, timeInMilliseconds);
        vec3.copy(scratchUp, enemy.up);
    }
    if (localYawRadians !== 0) {
        quat.setAxisAngle(scratchRotation, scratchUp, localYawRadians);
        vec3.transformQuat(scratchDirection, scratchDirection, scratchRotation);
    }
    calcOrientedModelMatrix(dst, scratchPosition, scratchDirection, scratchUp, modelScale);
}

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

interface NodeDefensePreviewSample {
    angle: number;
    team: number | null;
}

function sampleNodeDefensePreview(timeInMilliseconds: number): NodeDefensePreviewSample {
    const ticks = Math.max(0, timeInMilliseconds * 30 / 1000);
    const cycleTicks = 600;
    const idleTicks = 180;
    const captureTicks = 300;
    const decelerationTicks = 100;
    const cycle = Math.floor(ticks / cycleTicks);
    const timeInCycle = ticks - cycle * cycleTicks;

    // UpdateNodeDefenseCaptureState @ 0x0212EA38 advances capture progress by
    // two per tick, maps it to angular speed with 0x1B4E81B5, then subtracts
    // 614.4 fixed-angle units per unoccupied tick until the terminal stops.
    const captureAngle = 204.8 * captureTicks * (captureTicks + 1) / 2;
    const decelerationAngle = 614.4 * decelerationTicks * (decelerationTicks - 1) / 2;
    let angleFX = cycle * (captureAngle + decelerationAngle);
    let team: number | null = cycle === 0 ? null : (cycle - 1) & 1;
    if (timeInCycle >= idleTicks) {
        const captureTime = Math.min(timeInCycle - idleTicks, captureTicks);
        angleFX += 204.8 * captureTime * (captureTime + 1) / 2;
        team = cycle & 1;
        if (timeInCycle >= idleTicks + captureTicks) {
            const decelerationTime = Math.min(timeInCycle - idleTicks - captureTicks, decelerationTicks);
            angleFX += 614.4 * decelerationTime * (2 * decelerationTicks - decelerationTime - 1) / 2;
        }
    }
    return {
        angle: angleFX / (360 * 0x1000) * Math.PI * 2,
        team,
    };
}

function calcNodeDefenseTerminalModelMatrix(dst: mat4, nodeDefense: MPHNodeDefenseEntity, timeInMilliseconds: number, modelScale: number): void {
    // RenderNodeDefenseEntity @ 0x0212E4A4 rotates and uniformly scales the
    // terminal by the authored volume radius before placing it at +0x30.
    calcOrientedModelMatrix(dst, nodeDefense.position, nodeDefense.facing, nodeDefense.up, modelScale * nodeDefense.radius);
    mat4.rotateY(dst, dst, sampleNodeDefensePreview(timeInMilliseconds).angle);
}

function calcNodeDefenseDataFlowModelMatrix(dst: mat4, nodeDefense: MPHNodeDefenseEntity, modelScale: number): void {
    mat4.fromTranslation(dst, nodeDefense.position);
    mat4.scale(dst, dst, vec3.set(scratchScale, modelScale, modelScale, modelScale));
}

function modifyNodeDefenseMaterialColor(dst: { r: number, g: number, b: number, a: number }, materialName: string, timeInMilliseconds: number): void {
    if (materialName !== 'lambert2' && materialName !== 'lambert4')
        return;

    // RenderNodeDefenseEntity @ 0x0212E4A4 uses white for neutral, then the
    // capturing team's color while contested and the owner's color afterward.
    const team = sampleNodeDefensePreview(timeInMilliseconds).team;
    if (team === null) {
        dst.r = dst.g = dst.b = 1;
    } else if (team === 0) {
        dst.r = 1;
        dst.g = dst.b = 0;
    } else {
        dst.r = dst.g = 15 / 31;
        dst.b = 1;
    }
}

function calcTeleporterModelMatrix(dst: mat4, teleporter: MPHTeleporterEntity, modelScale: number): void {
    calcOrientedModelMatrix(dst, teleporter.position, teleporter.facing, teleporter.up, modelScale);
}

function calcForceFieldModelMatrix(dst: mat4, forceField: MPHForceFieldEntity, modelScale: number): void {
    const target = vec3.sub(vec3.create(), forceField.position, forceField.facing);
    mat4.targetTo(dst, forceField.position, target, forceField.up);
    mat4.scale(dst, dst, [modelScale * forceField.width, modelScale * forceField.height, modelScale]);
}

function calcItemSpawnPosition(dst: vec3, item: MPHItemSpawnEntity, parentPlatform: MPHPlatformEntity | null,
    timeInMilliseconds: number): void {
    vec3.copy(dst, item.position);
    if (parentPlatform === null || parentPlatform.positions.length === 0)
        return;

    // InitializeEntityParentRelativePosition @ 0x02048698 and
    // UpdateEntityPositionFromParentTransform @ 0x02048700 preserve the
    // authored world-space offset while carrying a child by its parent's
    // transform. Unit3_C2 item 9 is the one shipped parented ItemSpawn.
    samplePlatformPath(scratchItemParentPosition, scratchItemParentRotation, parentPlatform, timeInMilliseconds);
    vec3.sub(scratchItemLocalOffset, item.position, parentPlatform.positions[0]);
    quat.invert(scratchItemRotationDelta, parentPlatform.rotations[0]);
    quat.mul(scratchItemRotationDelta, scratchItemParentRotation, scratchItemRotationDelta);
    vec3.transformQuat(scratchItemLocalOffset, scratchItemLocalOffset, scratchItemRotationDelta);
    vec3.add(dst, scratchItemParentPosition, scratchItemLocalOffset);
}

function calcItemSpawnModelMatrix(dst: mat4, item: MPHItemSpawnEntity, parentPlatform: MPHPlatformEntity | null,
    phaseAngle: number, timeInMilliseconds: number, modelScale: number): void {
    calcItemSpawnPosition(scratchItemPosition, item, parentPlatform, timeInMilliseconds);
    // Item instances spawn 2662 FX32 units above their entity position.
    const baseY = scratchItemPosition[1] + 2662 / 0x1000;
    // UpdateItemInstance advances rotation by 0x300 angle units per tick and
    // uses the same phase for a 0x200-FX32 vertical bob.
    const ticks = timeInMilliseconds * 30 / 1000;
    const angle = fxAngle(phaseAngle + ticks * 0x300);
    const bob = Math.sin(angle) * (0x200 / 0x1000);
    mat4.fromYRotation(dst, angle);
    dst[12] = scratchItemPosition[0];
    dst[13] = (baseY + bob);
    dst[14] = scratchItemPosition[2];
    vec3.set(scratchScale, modelScale, modelScale, modelScale);
    mat4.scale(dst, dst, scratchScale);
}

function calcItemSpawnBaseModelMatrix(dst: mat4, item: MPHItemSpawnEntity, parentPlatform: MPHPlatformEntity | null,
    timeInMilliseconds: number, modelScale: number): void {
    calcItemSpawnPosition(scratchItemPosition, item, parentPlatform, timeInMilliseconds);
    mat4.fromTranslation(dst, scratchItemPosition);
    vec3.set(scratchScale, modelScale, modelScale, modelScale);
    mat4.scale(dst, dst, scratchScale);
}

// Max door animation length is 2s, 6s lets us cycle open/hold/close for both
// doors across a connector without enabling visibility through.
const DOOR_OPEN_HOLD_DURATION = 2000;
const DOOR_HALF_CYCLE_DURATION = 6050;

function getAnimationLoopDuration(animation: MPHAnimation | null): number {
    const frameCount = animation?.node?.frameCount ?? animation?.material?.frameCount ?? animation?.texCoord?.frameCount ?? 1;
    return Math.max(1, frameCount - 1) * 1000 / 30;
}

const enemySpawnerModelSpec: MPHEntityModelSpec = {
    modelFilename: 'EnemySpawner_mdl_Model.bin',
    animationFilename: 'EnemySpawner_mdl_Anim.bin',
    animationId: 0,
    additionalAnimationIds: [1, 2],
    additionalTexCoordAnimationIds: [1, 2],
    additionalMaterialAnimationIds: [null, 2],
    // ApplySharedModelTextureBank @ 0x0205C6B4 uses shared bank zero.
    sharedTextureFilename: 'AlimbicTextureShare_img_Model.bin',
};

function isEnemySpawnActivationMessage(message: number, messageParam: number): boolean {
    // HandleEnemySpawnControllerMessage @ 0x0211E698.
    return message === 0x12 || message === 5 && messageParam !== 0;
}

interface MPHEnemyActivationPlan {
    rootVolume: MPHTriggerVolumeEntity | null;
    waveDepth: number;
}

interface MPHForceFieldTransitionPlan extends MPHEnemyActivationPlan {
    active: boolean;
}

interface MPHObjectStatePlan extends MPHEnemyActivationPlan {
    state: number;
}

interface MPHPlatformStatePlan extends MPHEnemyActivationPlan {
    animationActive: boolean;
    movementActive: boolean;
}

const ENEMY_PREVIEW_WAVE_DWELL_MS = 6000;
const FORCE_FIELD_FADE_DURATION_MS = 31 * 1000 / 30;

interface MPHEntityActivationPlans {
    enemies: Map<number, MPHEnemyActivationPlan[]>;
    items: Map<number, MPHEnemyActivationPlan[]>;
    forceFields: Map<number, MPHForceFieldTransitionPlan[]>;
    objects: Map<number, MPHObjectStatePlan[]>;
    platforms: Map<number, MPHPlatformStatePlan[]>;
}

function addEntityActivationPlan(plansByEntityId: Map<number, MPHEnemyActivationPlan[]>,
        entityId: number, rootVolume: MPHTriggerVolumeEntity | null, waveDepth: number): void {
    let plans = plansByEntityId.get(entityId);
    if (plans === undefined)
        plansByEntityId.set(entityId, plans = []);
    if (!plans.some((plan) => plan.rootVolume === rootVolume && plan.waveDepth === waveDepth))
        plans.push({ rootVolume, waveDepth });
}

function addForceFieldTransitionPlan(plansByEntityId: Map<number, MPHForceFieldTransitionPlan[]>,
        entityId: number, rootVolume: MPHTriggerVolumeEntity | null, waveDepth: number, active: boolean): void {
    let plans = plansByEntityId.get(entityId);
    if (plans === undefined)
        plansByEntityId.set(entityId, plans = []);
    if (!plans.some((plan) =>
        plan.rootVolume === rootVolume && plan.waveDepth === waveDepth && plan.active === active))
        plans.push({ rootVolume, waveDepth, active });
}

function addObjectStatePlan(plansByEntityId: Map<number, MPHObjectStatePlan[]>,
        entityId: number, rootVolume: MPHTriggerVolumeEntity | null, waveDepth: number, state: number): void {
    let plans = plansByEntityId.get(entityId);
    if (plans === undefined)
        plansByEntityId.set(entityId, plans = []);
    if (!plans.some((plan) =>
        plan.rootVolume === rootVolume && plan.waveDepth === waveDepth && plan.state === state))
        plans.push({ rootVolume, waveDepth, state });
}

function addPlatformStatePlan(plansByEntityId: Map<number, MPHPlatformStatePlan[]>,
        entityId: number, rootVolume: MPHTriggerVolumeEntity | null, waveDepth: number,
        animationActive: boolean, movementActive: boolean): void {
    let plans = plansByEntityId.get(entityId);
    if (plans === undefined)
        plansByEntityId.set(entityId, plans = []);
    if (!plans.some((plan) =>
        plan.rootVolume === rootVolume && plan.waveDepth === waveDepth &&
        plan.animationActive === animationActive && plan.movementActive === movementActive))
        plans.push({ rootVolume, waveDepth, animationActive, movementActive });
}

function buildEntityActivationPlans(entities: MPHEntities): MPHEntityActivationPlans {
    const triggerById = new Map(entities.triggerVolumes.map((trigger) => [trigger.entityId, trigger]));
    const enemyById = new Map(entities.enemySpawns.map((enemy) => [enemy.entityId, enemy]));
    const itemById = new Map(entities.itemSpawns.map((item) => [item.entityId, item]));
    const forceFieldById = new Map(entities.forceFields.map((forceField) => [forceField.entityId, forceField]));
    const objectById = new Map(entities.objects.map((object) => [object.entityId, object]));
    const platformById = new Map(entities.platforms.map((platform) => [platform.entityId, platform]));
    const result: MPHEntityActivationPlans = {
        enemies: new Map(),
        items: new Map(),
        forceFields: new Map(),
        objects: new Map(),
        platforms: new Map(),
    };

    interface MessageEvent {
        targetId: number;
        message: number;
        messageParam: number;
        waveDepth: number;
        visitedRelays: Set<number>;
    }

    const simulate = (rootVolume: MPHTriggerVolumeEntity | null, initialEvents: MessageEvent[],
            initiallyCompletedEnemies: MPHEnemySpawnEntity[] = []): void => {
        const events = initialEvents;
        const remainingCounters = new Map(entities.triggerVolumes.map((trigger) =>
            [trigger.entityId, trigger.counter]));
        const completedEnemies = new Set<number>();

        const enqueueCompletion = (enemy: MPHEnemySpawnEntity, waveDepth: number): void => {
            // HandleEnemySpawnControllerMessage @ 0x0211E698 also completes
            // an unlimited controller after its destructible spawner has
            // disabled it and its remaining live children have been defeated.
            if ((enemy.totalSpawnLimit === 0 && enemy.spawnerHealth === 0) ||
                completedEnemies.has(enemy.entityId))
                return;
            completedEnemies.add(enemy.entityId);
            // CompleteEnemySpawnController @ 0x0211DA14 sends param0 = -1
            // and param1 = 0 after the finite wave has exhausted its spawn
            // count and all live children are gone.
            for (let i = 0; i < enemy.completionTargetEntityIds.length; i++) {
                const targetId = enemy.completionTargetEntityIds[i];
                const message = enemy.completionMessages[i];
                if (targetId !== -1 && message !== 0)
                    events.push({ targetId, message, messageParam: -1, waveDepth: waveDepth + 1, visitedRelays: new Set() });
            }
        };

        for (const enemy of initiallyCompletedEnemies)
            enqueueCompletion(enemy, 0);

        for (let eventIndex = 0; eventIndex < events.length && eventIndex < 10000; eventIndex++) {
            const event = events[eventIndex];
            const enemy = enemyById.get(event.targetId);
            if (enemy !== undefined && isEnemySpawnActivationMessage(event.message, event.messageParam)) {
                addEntityActivationPlan(result.enemies, enemy.entityId, rootVolume, event.waveDepth);
                enqueueCompletion(enemy, event.waveDepth);
                continue;
            }
            const item = itemById.get(event.targetId);
            // HandleItemSpawnMessage @ 0x02106C00 uses the same activation
            // messages as the EnemySpawn controller.
            if (item !== undefined && isEnemySpawnActivationMessage(event.message, event.messageParam)) {
                addEntityActivationPlan(result.items, item.entityId, rootVolume, event.waveDepth);
                continue;
            }
            const forceField = forceFieldById.get(event.targetId);
            if (forceField !== undefined && (event.message === 0x10 || event.message === 0x11)) {
                // HandleForceFieldMessage @ 0x02169100.
                addForceFieldTransitionPlan(result.forceFields, forceField.entityId,
                    rootVolume, event.waveDepth, event.message === 0x11);
                continue;
            }
            const object = objectById.get(event.targetId);
            if (object !== undefined && (event.message === 0x12 || event.message === 5)) {
                // HandleObjectEntityMessage @ 0x0216A994.
                const state = event.message === 0x12 ? 2 : event.messageParam & 0xFF;
                if (state < 4)
                    addObjectStatePlan(result.objects, object.entityId, rootVolume, event.waveDepth, state);
                continue;
            }
            const platform = platformById.get(event.targetId);
            if (platform !== undefined) {
                // HandlePlatformEntityMessage @ 0x0216E854.
                if (event.message === 0x12)
                    addPlatformStatePlan(result.platforms, platform.entityId,
                        rootVolume, event.waveDepth, true, true);
                else if (event.message === 5)
                    addPlatformStatePlan(result.platforms, platform.entityId,
                        rootVolume, event.waveDepth, event.messageParam !== 0, event.messageParam !== 0);
                else if (event.message === 0x2C)
                    addPlatformStatePlan(result.platforms, platform.entityId,
                        rootVolume, event.waveDepth, true, event.messageParam !== 0);
                else if (event.message === 0x2D)
                    addPlatformStatePlan(result.platforms, platform.entityId,
                        rootVolume, event.waveDepth, false, false);
                else
                    continue;
                continue;
            }

            const trigger = triggerById.get(event.targetId);
            if (trigger === undefined)
                continue;
            if (trigger.mode === 2) {
                if (event.visitedRelays.has(trigger.entityId))
                    continue;
                const visitedRelays = new Set(event.visitedRelays);
                visitedRelays.add(trigger.entityId);
                // HandleTriggerVolumeMessage @ 0x0210B348 forwards the
                // incoming message unchanged through both mode-2 targets.
                for (const targetId of trigger.targetEntityIds)
                    if (targetId !== -1)
                        events.push({ ...event, targetId, visitedRelays });
            } else if (trigger.mode === 1 && trigger.initialState !== 0 && event.message === 9) {
                const remaining = Math.max(0, (remainingCounters.get(trigger.entityId) ?? 0) - 1);
                remainingCounters.set(trigger.entityId, remaining);
                if (remaining === 0) {
                    // UpdateTriggerVolumeEntity @ 0x0210AA84 dispatches the
                    // authored outputs once HandleTriggerVolumeMessage has
                    // reduced the mode-1 runtime counter to zero.
                    for (let i = 0; i < trigger.targetEntityIds.length; i++) {
                        const targetId = trigger.targetEntityIds[i];
                        if (targetId !== -1)
                            events.push({
                                targetId,
                                message: trigger.messages[i],
                                messageParam: trigger.messageParams[i],
                                waveDepth: event.waveDepth,
                                visitedRelays: new Set(),
                            });
                    }
                }
            }
        }
    };

    for (const trigger of entities.triggerVolumes) {
        // UpdateTriggerVolumeEntity @ 0x0210AA84 performs player-volume
        // intersection only for active mode-0 triggers.
        if (trigger.mode !== 0 || trigger.initialState === 0)
            continue;
        const events: MessageEvent[] = [];
        for (let i = 0; i < trigger.targetEntityIds.length; i++) {
            const targetId = trigger.targetEntityIds[i];
            if (targetId !== -1)
                events.push({
                    targetId,
                    message: trigger.messages[i],
                    messageParam: trigger.messageParams[i],
                    waveDepth: 0,
                    visitedRelays: new Set(),
                });
        }
        simulate(trigger, events);
    }

    // Initially active finite controllers can also complete and advance an
    // authored counter chain without a spatial TriggerVolume root.
    simulate(null, [], entities.enemySpawns.filter((enemy) => enemy.initialState !== 0));
    return result;
}

function getPlannedActivationTime(plans: readonly MPHEnemyActivationPlan[], time: number,
        sceneStartTime: number, cameraRoomPosition: vec3, rootActivationTimes: Map<number, number>): number | null {
    let earliestActivationTime: number | null = null;
    for (const plan of plans) {
        let rootActivationTime = sceneStartTime;
        if (plan.rootVolume !== null) {
            rootActivationTime = rootActivationTimes.get(plan.rootVolume.entityId) ?? -1;
            if (rootActivationTime < 0 && pointInsideVolume(plan.rootVolume.volume, cameraRoomPosition)) {
                rootActivationTime = time;
                rootActivationTimes.set(plan.rootVolume.entityId, time);
            }
        }
        if (rootActivationTime < 0)
            continue;
        const activationTime = rootActivationTime + plan.waveDepth * ENEMY_PREVIEW_WAVE_DWELL_MS;
        if (time >= activationTime && (earliestActivationTime === null || activationTime < earliestActivationTime))
            earliestActivationTime = activationTime;
    }
    return earliestActivationTime;
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
        if (this.entities.itemSpawns.some((item) => item.showBase))
            this.cache.fetchMPHARC('archives/common.arc');
        if (this.entities.itemSpawns.some((item) => item.itemId === 19)) {
            this.cache.fetchMPHARC('archives/effectsBase.arc');
            this.cache.fetchMPFile('models/particles_Tex.bin');
            this.cache.fetchMPFile('effects/artifactKeyEffect_PS.bin');
        }
        for (const enemy of this.entities.enemySpawns) {
            for (const spec of getEnemyModelSpecs(enemy))
                requestEntityModel(this.cache, spec);
            if (enemy.spawnerHealth !== 0)
                requestEntityModel(this.cache, enemySpawnerModelSpec);
        }
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
        if (this.entities.nodeDefenses.length > 0) {
            // RegisterAndLoadNodeDefenseEntityType @ 0x0212F760
            requestEntityModel(this.cache, nodeDefenseTerminalModelSpec);
            requestEntityModel(this.cache, nodeDefenseDataFlowModelSpec);
        }
        if (this.entities.teleporters.some((teleporter) => !teleporter.invisible))
            requestEntityModel(this.cache, getTeleporterModelSpec(this.sceneMode));
        if (this.entities.forceFields.length > 0)
            requestEntityModel(this.cache, forceFieldModelSpec);
    }

    public createRenderers(device: GfxDevice, renderCache: GfxRenderCache, lighting: MPHLighting, fog: MPHFogConfig | null, sceneTransform?: mat4, staggerDoorCycles: boolean = false, collision: MPHCollisionData | null = null): { renderers: MPHRenderer[], doorRenderers: Map<number, MPHRenderer> } {
        const renderers: MPHRenderer[] = [];
        const doorRenderers = new Map<number, MPHRenderer>();
        const baseOptions: MPHRendererOptions = { sceneMode: this.sceneMode, lighting, fog, sceneTransform };
        const normalizedEntityFilename = normalizeEntityFilename(this.entityFilename);
        const inverseSceneTransform = sceneTransform !== undefined ?
            mat4.invert(mat4.create(), sceneTransform) : null;
        const entityActivationPlans = buildEntityActivationPlans(this.entities);
        for (const platform of this.entities.platforms) {
            const spec = getPlatformModelSpec(this.metadata, platform);
            if (spec === null)
                continue;
            const platform_ = assertExists(this.metadata.platforms[platform.modelId]);
            const statePlans = entityActivationPlans.platforms.get(platform.entityId) ?? [];
            let activeFrameTimeOverride: number | null = null;
            let playbackState: MPHPlatformPlaybackState | null = null;
            const platformRenderer = createEntityModelRenderer(device, this.cache, renderCache, spec, (animation, additionalAnimations) => {
                const hasStateAnimations = spec.additionalAnimationIds !== undefined;
                const rootActivationTimes = new Map<number, number>();
                const cameraRoomPosition = vec3.create();
                let sceneStartTime: number | null = null;
                let platformVisible = true;
                const animations = [animation, ...additionalAnimations];
                const animationIds = [spec.animationId, ...(spec.additionalAnimationIds ?? [])];
                const getAnimationDuration = (animationId: number): number => {
                    const index = animationIds.indexOf(animationId);
                    const candidate = index >= 0 ? animations[index] : null;
                    const frameCount = candidate?.node?.frameCount ??
                        candidate?.material?.frameCount ??
                        candidate?.texCoord?.frameCount ?? 1;
                    return Math.max(0, frameCount - 1) * 1000 / 30;
                };
                const updatePlatformState: NonNullable<MPHRendererOptions['isVisibleAtTime']> | undefined =
                    statePlans.length === 0 ? undefined : (time, viewerInput) => {
                        if (sceneStartTime === null)
                            sceneStartTime = time;
                        const cameraMatrix = viewerInput.camera.worldMatrix;
                        vec3.set(cameraRoomPosition, cameraMatrix[12], cameraMatrix[13], cameraMatrix[14]);
                        if (inverseSceneTransform !== null)
                            vec3.transformMat4(cameraRoomPosition, cameraRoomPosition, inverseSceneTransform);

                        const occurredPlans: { plan: MPHPlatformStatePlan; time: number }[] = [];
                        for (const plan of statePlans) {
                            const transitionTime = getPlannedActivationTime(
                                [plan], time, sceneStartTime, cameraRoomPosition, rootActivationTimes);
                            if (transitionTime !== null)
                                occurredPlans.push({ plan, time: transitionTime });
                        }
                        occurredPlans.sort((a, b) => a.time - b.time);

                        let animationActive = platform.active;
                        let previousAnimationActive = animationActive;
                        let animationTransitionTime = sceneStartTime;
                        let movementActive = platform.active;
                        let movementStartTime = sceneStartTime;
                        let movementElapsed = 0;
                        for (const event of occurredPlans) {
                            if (movementActive)
                                movementElapsed += event.time - movementStartTime;
                            movementStartTime = event.time;
                            movementActive = event.plan.movementActive;
                            previousAnimationActive = animationActive;
                            animationActive = event.plan.animationActive;
                            animationTransitionTime = event.time;
                        }
                        if (movementActive)
                            movementElapsed += time - movementStartTime;
                        activeFrameTimeOverride = movementActive || movementElapsed > 0 ?
                            movementElapsed * 30 / 1000 : -1;
                        playbackState = {
                            active: animationActive,
                            previousActive: previousAnimationActive,
                            transitionElapsed: time - animationTransitionTime,
                        };

                        platformVisible = true;
                        if (hasStateAnimations && !animationActive) {
                            const inactiveAnimationId = platform_.animationIds[0];
                            if (previousAnimationActive) {
                                const deactivateAnimationId = platform_.animationIds[3];
                                platformVisible = deactivateAnimationId >= 0 &&
                                    playbackState.transitionElapsed < getAnimationDuration(deactivateAnimationId) ||
                                    inactiveAnimationId >= 0;
                            } else {
                                platformVisible = inactiveAnimationId >= 0;
                            }
                        }
                        return platformVisible;
                    };
                return {
                    ...baseOptions,
                    isVisibleAtTime: updatePlatformState,
                    selectNodeAnimation: hasStateAnimations ?
                        (time) => samplePlatformAnimation(
                            platform, platform_, spec, animation, additionalAnimations, time, playbackState).index : undefined,
                    additionalMaterialAnimations: hasStateAnimations ?
                        additionalAnimations.map((animation) => animation.material) : undefined,
                    additionalTexCoordAnimations: hasStateAnimations ?
                        additionalAnimations.map((animation) => animation.texCoord) : undefined,
                    selectMaterialAnimation: hasStateAnimations ?
                        (time) => samplePlatformAnimation(
                            platform, platform_, spec, animation, additionalAnimations, time, playbackState).index : undefined,
                    selectTexCoordAnimation: hasStateAnimations ?
                        (time) => samplePlatformAnimation(
                            platform, platform_, spec, animation, additionalAnimations, time, playbackState).index : undefined,
                    mapAnimationTime: hasStateAnimations ?
                        (time) => samplePlatformAnimation(
                            platform, platform_, spec, animation, additionalAnimations, time, playbackState).timeInAnimation : undefined,
                };
            });
            if (platform.positions.length > 1)
                this.movers.push((time) => calcPlatformModelMatrix(
                    platformRenderer.modelMatrix, platform, time, platformRenderer.modelScale, activeFrameTimeOverride));
            else
                setupPlatformModelMatrix(platformRenderer.modelMatrix, platform, platformRenderer.modelScale);
            renderers.push(platformRenderer);
            if (platform.modelId === 23 || platform.modelId === 44) {
                for (const nodeName of ['R_Turret', 'R_Turret1', 'R_Turret2', 'R_Turret3'])
                    renderers.push(...createSamusShipExhaustRenderers(device, this.cache, renderCache, platformRenderer, nodeName, baseOptions, this.movers));
            }
        }
        for (const object of this.entities.objects) {
            const spec = getObjectModelSpec(this.metadata, object);
            if (spec === null)
                continue;
            const statePlans = entityActivationPlans.objects.get(object.entityId) ?? [];
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, spec, (animation, additionalAnimations) => {
                if (statePlans.length === 0) {
                    return {
                        ...baseOptions,
                    };
                }

                const object_ = assertExists(this.metadata.objects[object.modelId]);
                const rootActivationTimes = new Map<number, number>();
                const cameraRoomPosition = vec3.create();
                let sceneStartTime: number | null = null;
                let currentState = object.initialState;
                let currentStateStartTime = 0;
                const animations = [animation, ...additionalAnimations];
                const animationIds = [spec.animationId, ...(spec.additionalAnimationIds ?? [])];
                const getStateAnimationIndex = (state: number): number => {
                    const index = animationIds.indexOf(object_.animationIds[state]);
                    return index >= 0 ? index : 0;
                };
                const getStateAnimationDuration = (state: number): number => {
                    const stateAnimation = animations[getStateAnimationIndex(state)];
                    const frameCount = stateAnimation?.node?.frameCount ??
                        stateAnimation?.material?.frameCount ??
                        stateAnimation?.texCoord?.frameCount ?? 1;
                    return Math.max(0, frameCount - 1) * 1000 / 30;
                };
                const updateObjectState: NonNullable<MPHRendererOptions['isVisibleAtTime']> = (time, viewerInput) => {
                    if (sceneStartTime === null) {
                        sceneStartTime = time;
                        currentStateStartTime = time;
                    }
                    const cameraMatrix = viewerInput.camera.worldMatrix;
                    vec3.set(cameraRoomPosition, cameraMatrix[12], cameraMatrix[13], cameraMatrix[14]);
                    if (inverseSceneTransform !== null)
                        vec3.transformMat4(cameraRoomPosition, cameraRoomPosition, inverseSceneTransform);

                    let state = object.initialState;
                    let latestTransitionTime = sceneStartTime;
                    for (const plan of statePlans) {
                        const transitionTime = getPlannedActivationTime(
                            [plan], time, sceneStartTime, cameraRoomPosition, rootActivationTimes);
                        if (transitionTime !== null && transitionTime >= latestTransitionTime) {
                            state = plan.state;
                            latestTransitionTime = transitionTime;
                        }
                    }
                    const elapsed = time - latestTransitionTime;
                    if (object.modelId === 0x35 && state === 1) {
                        // UpdateObjectEntity @ 0x0216ACE4 advances WallSwitch
                        // from its activation animation to its active state.
                        const duration = getStateAnimationDuration(state);
                        if (elapsed >= duration) {
                            state = 2;
                            latestTransitionTime += duration;
                        }
                    } else if (object.modelId >= 0x2F && object.modelId <= 0x34 && state === 1) {
                        // The six SecretSwitch palettes return from their
                        // activation animation to state zero.
                        const duration = getStateAnimationDuration(state);
                        if (elapsed >= duration) {
                            state = 0;
                            latestTransitionTime += duration;
                        }
                    }
                    currentState = state;
                    currentStateStartTime = latestTransitionTime;
                    return object_.animationIds[currentState] >= 0;
                };
                const selectAnimation = (): number => getStateAnimationIndex(currentState);
                const mapAnimationTime = (time: number): number => time - currentStateStartTime;
                return {
                    ...baseOptions,
                    isVisibleAtTime: updateObjectState,
                    additionalMaterialAnimations: animations.slice(1).map((candidate) => candidate?.material ?? null),
                    additionalTexCoordAnimations: animations.slice(1).map((candidate) => candidate?.texCoord ?? null),
                    selectNodeAnimation: selectAnimation,
                    selectMaterialAnimation: selectAnimation,
                    selectTexCoordAnimation: selectAnimation,
                    mapAnimationTime,
                    mapMaterialAnimationTime: mapAnimationTime,
                };
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
            const parentPlatform = this.entities.platforms.find((platform) => platform.entityId === item.parentEntityId) ?? null;
            const activationPlans = entityActivationPlans.items.get(item.entityId) ?? [];
            const rootActivationTimes = new Map<number, number>();
            const cameraRoomPosition = vec3.create();
            let sceneStartTime: number | null = null;
            let itemActivationTime: number | null = null;
            const getItemTime = (time: number): number => {
                if (sceneStartTime === null)
                    sceneStartTime = time;
                return time - (itemActivationTime ?? sceneStartTime);
            };
            // CreateItemSpawnEntity @ 0x021071F4 copies initialState from
            // +0x30. UpdateItemSpawnEntity @ 0x02106F9C waits the +0x38
            // timer before creating the live ItemInstance.
            const isItemVisible: NonNullable<MPHRendererOptions['isVisibleAtTime']> = (time, viewerInput) => {
                if (sceneStartTime === null)
                    sceneStartTime = time;
                if (itemActivationTime === null && item.initialState !== 0)
                    itemActivationTime = sceneStartTime;
                if (itemActivationTime === null) {
                    const cameraMatrix = viewerInput.camera.worldMatrix;
                    vec3.set(cameraRoomPosition, cameraMatrix[12], cameraMatrix[13], cameraMatrix[14]);
                    if (inverseSceneTransform !== null)
                        vec3.transformMat4(cameraRoomPosition, cameraRoomPosition, inverseSceneTransform);
                    itemActivationTime = getPlannedActivationTime(
                        activationPlans, time, sceneStartTime, cameraRoomPosition, rootActivationTimes);
                }
                return itemActivationTime !== null &&
                    (time - itemActivationTime) * 30 / 1000 >= item.initialDelayTicks;
            };
            const itemRenderer = createEntityModelRenderer(device, this.cache, renderCache, getItemModelSpec(this.metadata, item), {
                ...baseOptions,
                isVisibleAtTime: isItemVisible,
            });
            this.movers.push((time) => calcItemSpawnModelMatrix(
                itemRenderer.modelMatrix, item, parentPlatform, phaseAngle, getItemTime(time), itemRenderer.modelScale));
            renderers.push(itemRenderer);
            if (item.itemId === 19)
                renderers.push(...createArtifactKeyEffectRenderers(device, this.cache, renderCache,
                    item, parentPlatform, getItemTime, isItemVisible, baseOptions, this.movers));
            if (item.showBase) {
                const baseRenderer = createEntityModelRenderer(device, this.cache, renderCache, itemSpawnBaseModelSpec, baseOptions);
                this.movers.push((time) => calcItemSpawnBaseModelMatrix(
                    baseRenderer.modelMatrix, item, parentPlatform, getItemTime(time), baseRenderer.modelScale));
                renderers.push(baseRenderer);
            }
        }
        for (const enemy of this.entities.enemySpawns) {
            const simulation: MPHEnemySimulation | null =
                (enemy.enemyType === 0x01 || enemy.enemyType === 0x0C) && collision !== null ?
                    new SurfaceCrawlerSimulation(enemy, collision) :
                    enemy.enemyType === 0x23 || enemy.enemyType === 0x24 ?
                        new GuardBotSimulation(enemy, collision, getEnemyAnimationPhaseMilliseconds(enemy) %
                            (enemy.enemyType === 0x23 ? 445 * 1000 / 30 : 12 * 1000)) :
                    enemy.enemyType === 0x05 ? new MochtroidRoamingSimulation(enemy, 20) :
                    enemy.enemyType === 0x06 ? new MochtroidRoamingSimulation(enemy, 10) : null;
            let controllerStartTime: number | null = null;
            let controllerActivationTime: number | null = null;
            let controllerActive = enemy.initialState !== 0;
            let enemySpawnTime: number | null = null;
            let enemyTriggered = false;
            const activationPlans = entityActivationPlans.enemies.get(enemy.entityId) ?? [];
            const rootActivationTimes = new Map<number, number>();
            const cameraRoomPosition = vec3.create();
            const getControllerTime = (time: number): number => {
                if (controllerStartTime === null)
                    controllerStartTime = time;
                return time - controllerStartTime;
            };
            const getEnemyTime = (time: number): number => {
                return enemySpawnTime !== null ? time - enemySpawnTime : 0;
            };
            if (enemy.spawnerHealth !== 0) {
                // InitializeEnemySpawnerVisualization @ 0x0211E094 creates
                // this subtype-0x28 proxy and selects animation 0 for War
                // Wasps/Barbed War Wasps, otherwise 1 when active or 2 when
                // inactive (the latter starts at authored frame 20).
                const getSpawnerAnimation = (): number =>
                    enemy.enemyType === 0x00 || enemy.enemyType === 0x0A ? 0 :
                        controllerActive ? 1 : 2;
                const spawnerRenderer = createEntityModelRenderer(device, this.cache, renderCache, enemySpawnerModelSpec, {
                    ...baseOptions,
                    selectNodeAnimation: getSpawnerAnimation,
                    selectTexCoordAnimation: getSpawnerAnimation,
                    selectMaterialAnimation: getSpawnerAnimation,
                    mapAnimationTime: (time) => getSpawnerAnimation() === 2 ?
                        getControllerTime(time) + 20 * 1000 / 30 : getControllerTime(time),
                });
                this.movers.push((time) => calcEnemyModelMatrix(
                    spawnerRenderer.modelMatrix, enemy, null, getControllerTime(time), spawnerRenderer.modelScale));
                renderers.push(spawnerRenderer);
            }
            const enemyModelSpecs = getEnemyModelSpecs(enemy);
            let primaryEnemyRenderer: MPHRenderer | null = null;
            for (let specIndex = 0; specIndex < enemyModelSpecs.length; specIndex++) {
                const spec = enemyModelSpecs[specIndex];
                const renderer = createEntityModelRenderer(device, this.cache, renderCache, spec, (animation) => {
                    const duration = getAnimationLoopDuration(animation);
                    const animationLoop = spec.animationLoop !== false;
                    const getPreviewTime = (time: number): number =>
                        getEnemyTime(time) + getEnemyAnimationPhaseMilliseconds(enemy);
                    return {
                        ...baseOptions,
                        // UpdateEnemySpawnController @ 0x0211DCD8 does not
                        // create children until the controller is active and
                        // its authored initial delay has elapsed.
                        isVisibleAtTime: (time, viewerInput) => {
                            if (controllerStartTime === null)
                                controllerStartTime = time;
                            if (enemyTriggered)
                                return true;
                            const cameraMatrix = viewerInput.camera.worldMatrix;
                            vec3.set(cameraRoomPosition, cameraMatrix[12], cameraMatrix[13], cameraMatrix[14]);
                            if (inverseSceneTransform !== null)
                                vec3.transformMat4(cameraRoomPosition, cameraRoomPosition, inverseSceneTransform);
                            if (!controllerActive) {
                                const scheduledActivationTime = getPlannedActivationTime(
                                    activationPlans, time, controllerStartTime,
                                    cameraRoomPosition, rootActivationTimes);
                                if (scheduledActivationTime !== null) {
                                    controllerActive = true;
                                    controllerActivationTime = scheduledActivationTime;
                                }
                            }
                            if (!controllerActive)
                                return false;
                            if (controllerActivationTime === null)
                                controllerActivationTime = time;
                            if ((time - controllerActivationTime) * 30 / 1000 < enemy.initialDelayTicks)
                                return false;
                            const dx = cameraRoomPosition[0] - enemy.position[0];
                            const dy = cameraRoomPosition[1] - enemy.position[1];
                            const dz = cameraRoomPosition[2] - enemy.position[2];
                            const radius = enemy.activationRadius;
                            enemyTriggered = radius <= 0 || dx * dx + dy * dy + dz * dz < radius * radius;
                            if (enemyTriggered)
                                enemySpawnTime = time;
                            return enemyTriggered;
                        },
                        modifyNodeMatrix: enemy.enemyType === 0x12 ?
                            (dst, nodeName, time) => {
                                if (nodeName !== 'Door_Rot')
                                    return;
                                const scan = sampleAlimbicTurretAim(getPreviewTime(time), enemy);
                                mat4.rotateY(dst, dst, scan.yaw);
                                mat4.rotateX(dst, dst, scan.pitch);
                            } : undefined,
                        selectNodeAnimation: enemy.enemyType === 0x03 ?
                            (time) => sampleMochtroidType03Animation(getEnemyTime(time), enemy).index :
                            enemy.enemyType === 0x00 ?
                                (time) => sampleWarWaspAnimation(getPreviewTime(time), enemy.entityId).index :
                            enemy.enemyType === 0x0A ?
                                (time) => sampleBarbedWarWaspAnimation(getPreviewTime(time), enemy.entityId).index :
                            enemy.enemyType === 0x04 ?
                                (time) => sampleMochtroidType04Animation(getEnemyTime(time)).index :
                            enemy.enemyType === 0x05 ?
                                (time) => sampleMochtroidType05Animation(getEnemyTime(time)).index :
                            enemy.enemyType === 0x0B ?
                                (time) => sampleShriekbatAnimation(getPreviewTime(time), enemy.entityId).index :
                            enemy.enemyType === 0x10 ?
                                (time) => sampleBlastcapAnimation(getPreviewTime(time), enemy.entityId).index :
                            enemy.enemyType === 0x0C ?
                                (time) => sampleGeemerAnimation(getPreviewTime(time), enemy.entityId).index :
                            enemy.enemyType === 0x13 && specIndex === 0 ?
                                (time) => sampleCylinderBossAnimation(getPreviewTime(time)).index :
                                enemy.enemyType === 0x17 ?
                                    (time) => samplePsychoBitAnimation(getPreviewTime(time), enemy.entityId).index :
                                    enemy.enemyType === 0x2E || enemy.enemyType === 0x2F ?
                                        (time) => sampleSphinkTickAnimation(getPreviewTime(time), enemy.entityId).index :
                                    enemy.enemyType === 0x25 ?
                                        (time) => sampleDripStankAnimation(getPreviewTime(time)).index :
                                    enemy.enemyType === 0x24 ?
                                        (time) => sampleGuardBot1Animation(getPreviewTime(time)).index :
                                    enemy.enemyType === 0x23 ?
                                        (time) => sampleGuardBot2Animation(getPreviewTime(time)).index :
                                    enemy.enemyType === 0x26 ?
                                        (time) => sampleAlimbicStatueAnimation(getPreviewTime(time)).index :
                                    enemy.enemyType === 0x27 ?
                                        (time) => sampleLavaDemonAnimation(getPreviewTime(time)).index :
                                    enemy.enemyType === 0x18 && specIndex === 0 ?
                                        (time) => sampleGorea1AAnimation(getPreviewTime(time)).index :
                                    enemy.enemyType === 0x1F ?
                                        (time) => sampleGorea2Animation(getPreviewTime(time)).index :
                                    enemy.enemyType === 0x29 && spec.modelFilename === 'BigEyeBall_Model.bin' ?
                                        (time) => sampleBigEyeBossAnimation(getPreviewTime(time)).index :
                                enemy.enemyType === 0x06 ?
                                    (time) => sampleMochtroidType06Animation(getEnemyTime(time)).index : undefined,
                        selectMaterialAnimation: enemy.enemyType === 0x13 && specIndex === 0 ?
                            (time) => sampleCylinderBossAnimation(getPreviewTime(time)).materialIndex :
                            enemy.enemyType === 0x13 && spec.attachmentNodeName !== undefined ?
                                (time) => sampleCylinderBossEyeAnimation(getPreviewTime(time) + specIndex * 500).index :
                            enemy.enemyType === 0x18 && specIndex === 0 ? () => 1 : undefined,
                        // InitializeGorea1A @ 0x02133A18 starts material
                        // animation 26 independently at frame 8.
                        mapMaterialAnimationTime: enemy.enemyType === 0x18 && specIndex === 0 ?
                            (time) => getEnemyTime(time) + 8 * 1000 / 30 : undefined,
                        mapAnimationTime: (time) => {
                            const elapsed = getEnemyTime(time);
                            if (enemy.enemyType === 0x03) {
                                const sample = sampleMochtroidType03Animation(elapsed, enemy);
                                // ApplyMochtroidType03State @ 0x02164968 starts
                                // one-shot animations 3/4 and loops animation 0.
                                return sample.state === 1 ? sample.timeInState :
                                    Math.min(sample.timeInState, 19 * 1000 / 30);
                            }
                            if (enemy.enemyType === 0x00) {
                                const sample = sampleWarWaspAnimation(getPreviewTime(time), enemy.entityId);
                                return sample.state === 3 ?
                                    sample.timeInState + 8 * 1000 / 30 :
                                    sample.timeInState;
                            }
                            if (enemy.enemyType === 0x0A) {
                                const sample = sampleBarbedWarWaspAnimation(getPreviewTime(time), enemy.entityId);
                                return sample.state === 2 ?
                                    sample.timeInState + 8 * 1000 / 30 :
                                    sample.state === 3 ?
                                        sample.timeInState + 10 * 1000 / 30 :
                                        sample.timeInState;
                            }
                            if (enemy.enemyType === 0x04) {
                                const sample = sampleMochtroidType04Animation(elapsed);
                                return sample.state === 0 ?
                                    Math.min(sample.timeInState, 29 * 1000 / 30) :
                                    sample.timeInState;
                            }
                            if (enemy.enemyType === 0x05) {
                                const sample = sampleMochtroidType05Animation(elapsed);
                                return sample.state === 0 ?
                                    Math.min(sample.timeInState, 19 * 1000 / 30) :
                                    sample.timeInState;
                            }
                            if (enemy.enemyType === 0x10) {
                                const sample = sampleBlastcapAnimation(getPreviewTime(time), enemy.entityId);
                                return sample.state === 0 ? sample.timeInState :
                                    Math.min(sample.timeInState, 19 * 1000 / 30);
                            }
                            if (enemy.enemyType === 0x0C)
                                return sampleGeemerAnimation(getPreviewTime(time), enemy.entityId).timeInState;
                            if (enemy.enemyType === 0x13 && specIndex === 0)
                                return sampleCylinderBossAnimation(getPreviewTime(time)).timeInState;
                            if (enemy.enemyType === 0x0B)
                                return sampleShriekbatAnimation(getPreviewTime(time), enemy.entityId).timeInState;
                            if (enemy.enemyType === 0x17) {
                                const sample = samplePsychoBitAnimation(getPreviewTime(time), enemy.entityId);
                                return sample.timeInState;
                            }
                            if (enemy.enemyType === 0x2E || enemy.enemyType === 0x2F) {
                                const sample = sampleSphinkTickAnimation(getPreviewTime(time), enemy.entityId);
                                return sample.timeInState;
                            }
                            if (enemy.enemyType === 0x25) {
                                const sample = sampleDripStankAnimation(getPreviewTime(time));
                                return sample.state === 9 || sample.state === 10 ?
                                    sample.timeInState + 8 * 1000 / 30 :
                                    sample.timeInState;
                            }
                            if (enemy.enemyType === 0x24) {
                                const sample = sampleGuardBot1Animation(getPreviewTime(time));
                                return sample.timeInState;
                            }
                            if (enemy.enemyType === 0x23) {
                                const sample = sampleGuardBot2Animation(getPreviewTime(time));
                                return sample.timeInState;
                            }
                            if (enemy.enemyType === 0x26) {
                                const sample = sampleAlimbicStatueAnimation(getPreviewTime(time));
                                return sample.timeInState;
                            }
                            if (enemy.enemyType === 0x27) {
                                const sample = sampleLavaDemonAnimation(getPreviewTime(time));
                                // ProcessLavaDemonDormantState @ 0x0215F464
                                // retains the final concealed pose until the
                                // activation-volume transition occurs.
                                return sample.state === 0 || sample.state === 1 ?
                                    89 * 1000 / 30 : sample.timeInState;
                            }
                            if (enemy.enemyType === 0x18 && specIndex === 0) {
                                const sample = sampleGorea1AAnimation(getPreviewTime(time));
                                return sample.state === 8 ?
                                    sample.timeInState + 8 * 1000 / 30 :
                                    sample.timeInState;
                            }
                            if (enemy.enemyType === 0x1F) {
                                const sample = sampleGorea2Animation(getPreviewTime(time));
                                return sample.state === 9 ?
                                    sample.timeInState + 8 * 1000 / 30 :
                                    sample.timeInState;
                            }
                            if (enemy.enemyType === 0x29 && spec.modelFilename === 'BigEyeBall_Model.bin')
                                return sampleBigEyeBossAnimation(getPreviewTime(time)).timeInState;
                            if (enemy.enemyType === 0x13 && spec.attachmentNodeName !== undefined)
                                return sampleCylinderBossEyeAnimation(getPreviewTime(time) + specIndex * 500).timeInState;
                            if (enemy.enemyType === 0x2D)
                                return sampleBigEyeTurretAnimation(getPreviewTime(time)).timeInAnimation;
                            if (enemy.enemyType === 0x06) {
                                const sample = sampleMochtroidType06Animation(elapsed);
                                return sample.state === 0 ?
                                    Math.min(sample.timeInState, 9 * 1000 / 30) :
                                    sample.timeInState;
                            }
                            if (!animationLoop)
                                return Math.min(elapsed, duration);
                            return (elapsed + (isWaspEnemy(enemy) ? 0 : getEnemyAnimationPhaseMilliseconds(enemy))) % duration;
                        },
                    };
                });
                this.movers.push((time) => calcEnemyModelMatrix(renderer.modelMatrix, enemy, simulation, getEnemyTime(time), renderer.modelScale, spec.localYawRadians));
                renderers.push(renderer);
                if (specIndex === 0)
                    primaryEnemyRenderer = renderer;
            }
        }
        for (const artifact of this.entities.artifacts) {
            if (!artifact.active)
                continue;
            const colors: [vec3, vec3] = [vec3.clone(lighting.colors[0]), vec3.clone(lighting.colors[1])];
            const directions: [vec3, vec3] = [vec3.clone(lighting.directions[0]), vec3.clone(lighting.directions[1])];
            for (const light of this.entities.lightSources) {
                if (!pointInsideVolume(light.volume, artifact.position))
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
        for (const nodeDefense of this.entities.nodeDefenses) {
            renderers.push(createEntityModelRenderer(device, this.cache, renderCache, nodeDefenseTerminalModelSpec, {
                ...baseOptions,
                modifyMaterialColor: modifyNodeDefenseMaterialColor,
            }));
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, nodeDefenseDataFlowModelSpec, {
                ...baseOptions,
                modifyMaterialColor: modifyNodeDefenseMaterialColor,
            });
            calcNodeDefenseDataFlowModelMatrix(renderer.modelMatrix, nodeDefense, renderer.modelScale);
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
            const transitionPlans = entityActivationPlans.forceFields.get(forceField.entityId) ?? [];
            const rootActivationTimes = new Map<number, number>();
            const cameraRoomPosition = vec3.create();
            let sceneStartTime: number | null = null;
            let currentAlpha = forceField.active ? 1 : 0;
            const updateForceFieldState: NonNullable<MPHRendererOptions['isVisibleAtTime']> = (time, viewerInput) => {
                if (sceneStartTime === null)
                    sceneStartTime = time;
                const cameraMatrix = viewerInput.camera.worldMatrix;
                vec3.set(cameraRoomPosition, cameraMatrix[12], cameraMatrix[13], cameraMatrix[14]);
                if (inverseSceneTransform !== null)
                    vec3.transformMat4(cameraRoomPosition, cameraRoomPosition, inverseSceneTransform);

                let active = forceField.active;
                let latestTransitionTime = sceneStartTime;
                for (const plan of transitionPlans) {
                    const transitionTime = getPlannedActivationTime(
                        [plan], time, sceneStartTime, cameraRoomPosition, rootActivationTimes);
                    if (transitionTime !== null && transitionTime >= latestTransitionTime) {
                        active = plan.active;
                        latestTransitionTime = transitionTime;
                    }
                }
                const fadeProgress = Math.min(1, Math.max(0,
                    (time - latestTransitionTime) / FORCE_FIELD_FADE_DURATION_MS));
                currentAlpha = active ? fadeProgress : 1 - fadeProgress;
                if (latestTransitionTime === sceneStartTime && active === forceField.active)
                    currentAlpha = active ? 1 : 0;
                return currentAlpha > 0;
            };
            const renderer = createEntityModelRenderer(device, this.cache, renderCache, getForceFieldModelSpec(forceField), (animation) => {
                const duration = getAnimationLoopDuration(animation);
                return {
                    ...baseOptions,
                    mapAnimationTime: (time) => time % duration,
                    isVisibleAtTime: updateForceFieldState,
                    // UpdateForceFieldEntity @ 0x02168D48 changes the five-bit
                    // polygon alpha by one every 30 Hz update until it reaches
                    // zero or 31; RenderForceFieldEntity @ 0x02168B70 submits it.
                    modifyMaterialColor: (dst) => dst.a *= currentAlpha,
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
