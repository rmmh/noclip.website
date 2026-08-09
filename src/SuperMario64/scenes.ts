import { mat4, vec3 } from 'gl-matrix';
import { decompress } from 'fzstd';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import * as BYML from '../byml.js';
import { CameraController } from '../Camera.js';
import { makeBackbufferDescSimple, standardFullClearRenderPassDescriptor } from '../gfx/helpers/RenderGraphHelpers.js';
import { fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { GfxRenderHelper } from '../gfx/render/GfxRenderHelper.js';
import { GfxRenderInstList } from '../gfx/render/GfxRenderInstManager.js';
import { GfxrAttachmentSlot } from '../gfx/render/GfxRenderGraph.js';
import { GfxBindingLayoutDescriptor, GfxDevice } from '../gfx/platform/GfxPlatform.js';
import { SceneContext } from '../SceneBase.js';
import { FakeTextureHolder } from '../TextureHolder.js';
import * as Viewer from '../viewer.js';
import { F3DEX_Program } from '../BanjoKazooie/render.js';
import { RSP_Geometry } from '../BanjoKazooie/f3dex.js';
import { RENDER_MODES } from '../Common/N64/RDP.js';
import { MkRSPState } from '../MarioKart64/f3dex.js';
import { BasicRspRenderer } from '../MarioKart64/render.js';
import { runDL_F3D } from './f3d.js';
import { decodeAnimationTable, parseGeoLayout } from './geo.js';
import type { GeoAnimationPose } from './geo.js';
import { createSkyboxRenderer } from './render.js';
import type { SkyboxRenderer } from './render.js';

const pathBase = 'SuperMario64';

interface ObjectInfo { model: number; position: number[]; rotation: number[]; behavior?: number; behaviorParameter?: number; billboard?: boolean; billboardDepthOffset?: number; scale?: number; scaleXYZ?: number[]; graphYOffset?: number; motionPath?: number[][]; motionSpeed?: number; motionPathFrameStep?: number; spawnPeriod?: number; nearSpawnPeriod?: number; spawnDistanceMin?: number; spawnDistanceMax?: number; spawnOdds?: number; spawnRequiresMarioBelow?: boolean; motionRollRate?: number; wigglerBodyIndex?: number; pokeyPartIndex?: number; chainPartIndex?: number; activationCenter?: number[]; activeFromAfar?: boolean; birdParent?: number[]; behaviorTarget?: number[]; spawnedByTriplet?: boolean; spawnedByScuttlebugSpawner?: boolean; randomSeedOffset?: number; }
interface MarioStart { area: number; yaw: number; position: number[]; }
interface DisplayListInfo { address: number; layer: number; }
interface MovtexInfo { kind: 'water' | 'sand' | 'lava'; vertices: number[][]; indices: number[]; alpha: number; scrollS?: number; rotation?: number; textureAddress: number; materialAddress?: number; lighting?: boolean; }
interface LevelInfo { id: string; name: string; displayLists: DisplayListInfo[]; segments: number[]; objects: ObjectInfo[]; movtex?: MovtexInfo[]; modelGeos?: Record<number, number>; modelDLs?: Record<number, number>; marioStart?: MarioStart; cameraMode?: number; }
interface LevelArchive { Segments: { ID: number; Data: ArrayBufferSlice }[]; Collision?: ArrayBufferSlice; }

interface CollisionFloor {
    ax: number; ay: number; az: number;
    bx: number; by: number; bz: number;
    cx: number; cy: number; cz: number;
    minX: number; maxX: number; minZ: number; maxZ: number;
    normalY: number;
}

interface CollisionFloorIndex {
    count: number;
    cells: Map<string, CollisionFloor[]>;
}

const collisionFloorCellSize = 1024;

function parseCollisionFloors(data: ArrayBufferSlice | undefined): CollisionFloorIndex {
    const cells = new Map<string, CollisionFloor[]>();
    if (data === undefined) return { count: 0, cells };
    const view = data.createDataView();
    let count = 0;
    for (let p = 0; p + 18 <= view.byteLength; p += 18) {
        const ax = view.getInt16(p), ay = view.getInt16(p + 2), az = view.getInt16(p + 4);
        const bx = view.getInt16(p + 6), by = view.getInt16(p + 8), bz = view.getInt16(p + 10);
        const cx = view.getInt16(p + 12), cy = view.getInt16(p + 14), cz = view.getInt16(p + 16);
        const ux = bx - ax, uy = by - ay, uz = bz - az;
        const vx = cx - ax, vy = cy - ay, vz = cz - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        if (length === 0 || ny <= 0) continue;
        const floor = { ax, ay, az, bx, by, bz, cx, cy, cz,
            minX: Math.min(ax, bx, cx), maxX: Math.max(ax, bx, cx), minZ: Math.min(az, bz, cz), maxZ: Math.max(az, bz, cz), normalY: ny / length };
        const minCellX = Math.floor(floor.minX / collisionFloorCellSize), maxCellX = Math.floor(floor.maxX / collisionFloorCellSize);
        const minCellZ = Math.floor(floor.minZ / collisionFloorCellSize), maxCellZ = Math.floor(floor.maxZ / collisionFloorCellSize);
        for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
            for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
                const key = `${cellX},${cellZ}`;
                let cell = cells.get(key);
                if (cell === undefined) cells.set(key, cell = []);
                cell.push(floor);
            }
        }
        count++;
    }
    return { count, cells };
}

function findCollisionFloor(floors: CollisionFloorIndex, x: number, y: number, z: number): { height: number; normalY: number } | null {
    let bestHeight = -Infinity, bestNormalY = 0;
    const candidates = floors.cells.get(`${Math.floor(x / collisionFloorCellSize)},${Math.floor(z / collisionFloorCellSize)}`);
    if (candidates === undefined) return null;
    for (const floor of candidates) {
        if (x < floor.minX || x > floor.maxX || z < floor.minZ || z > floor.maxZ) continue;
        const denominator = (floor.bz - floor.cz) * (floor.ax - floor.cx) + (floor.cx - floor.bx) * (floor.az - floor.cz);
        if (denominator === 0) continue;
        const wa = ((floor.bz - floor.cz) * (x - floor.cx) + (floor.cx - floor.bx) * (z - floor.cz)) / denominator;
        const wb = ((floor.cz - floor.az) * (x - floor.cx) + (floor.ax - floor.cx) * (z - floor.cz)) / denominator;
        const wc = 1 - wa - wb;
        if (wa < -0.0001 || wb < -0.0001 || wc < -0.0001) continue;
        const height = wa * floor.ay + wb * floor.by + wc * floor.cy;
        if (height <= y + 100 && height > bestHeight) { bestHeight = height; bestNormalY = floor.normalY; }
    }
    return bestHeight === -Infinity ? null : { height: bestHeight, normalY: bestNormalY };
}

function makeInitialCameraMatrix(levelId: string, start: MarioStart | undefined, cameraMode: number | undefined): mat4 {
    const matrix = mat4.create();
    if (start === undefined) return matrix;
    const yaw = start.yaw * Math.PI / 180;
    // These are init_camera()'s actual Mario-relative offsets. The initial
    // position is established before the active camera mode begins converging.
    let offsetX = 0, offsetY = 125, offsetZ = 400;
    if (levelId === 'sa') offsetZ = 200;
    else if (levelId === 'castle_courtyard') offsetZ = -300;
    else if (levelId === 'castle_inside') offsetZ = 150;

    // offset_rotated() intentionally flips local Z. Except in behind-Mario mode,
    // init_camera() then places Lakitu 125 units above Mario's starting floor.
    const eye = vec3.fromValues(
        start.position[0] - offsetZ * Math.sin(yaw) + offsetX * Math.cos(yaw),
        start.position[1] + offsetY,
        start.position[2] - offsetZ * Math.cos(yaw) - offsetX * Math.sin(yaw),
    );
    if (cameraMode !== 0x03) eye[1] = start.position[1] + 125;
    const target = vec3.fromValues(start.position[0], start.position[1], start.position[2]);
    return mat4.targetTo(matrix, eye, target, [0, 1, 0]);
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 3, numSamplers: 2 },
];

const binang = (angle: number): number => angle * Math.PI / 0x8000;
const binang3 = (x: number, y: number, z: number): [number, number, number] => [binang(x), binang(y), binang(z)];
const billboardOffsetScratch = vec3.create();

function samplePath(path: number[][], distance: number): number[] {
    for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i];
        const length = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (distance <= length) {
            const t = length === 0 ? 0 : distance / length;
            return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
        }
        distance -= length;
    }
    return path[path.length - 1];
}

function pathLength(path: number[][]): number {
    let result = 0;
    for (let i = 1; i < path.length; i++)
        result += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]);
    return result;
}

function sampleFramePath(path: number[][], age: number, frameStep: number): number[] {
    const frame = age / frameStep;
    const index = Math.min(Math.floor(frame), path.length - 2);
    const a = vec3.fromValues(path[index][0], path[index][1], path[index][2]);
    const b = vec3.fromValues(path[index + 1][0], path[index + 1][1], path[index + 1][2]);
    return Array.from(vec3.lerp(a, a, b, frame - index));
}

function withoutInheritedScale(matrix: mat4): mat4 {
    // SM64's mtxf_billboard keeps only the parent-transformed position. Its
    // basis comes from the camera, after which geo_process_billboard reapplies
    // the object's graphical scale. In Goomba's layout this node is the lower
    // body piece between the animated head and feet, not the textured face.
    const result = mat4.create();
    result[12] = matrix[12];
    result[13] = matrix[13];
    result[14] = matrix[14];
    return result;
}

type IdleBehavior = 'goomba' | 'bobomb' | 'bobombBuddy' | 'bowser' | 'bubba' | 'bully' | 'butterfly' | 'tripletButterfly' | 'bird' | 'boo' | 'booInCastle' | 'booSpawner' | 'booWithCage' | 'balconyBigBoo' | 'dormantBigBoo' | 'chainChomp' | 'chuckya' | 'circlingAmp' | 'clam' | 'dorrie' | 'enemyLakitu' | 'eyerokHand' | 'firePiranha' | 'fireSpitter' | 'fish' | 'flyGuy' | 'hauntedChair' | 'heaveHo' | 'homingAmp' | 'horizontalGrindel' | 'jumpingBox' | 'kingBobomb' | 'kingWhomp' | 'klepto' | 'koopa' | 'largeBomp' | 'madPiano' | 'montyMole' | 'mrBlizzard' | 'mrI' | 'piranhaPlant' | 'pokey' | 'scuttlebug' | 'skeeter' | 'smallBomp' | 'smallPenguin' | 'smallWhomp' | 'snufit' | 'spindel' | 'spindrift' | 'sushi' | 'swoop' | 'tankFish' | 'toxBox' | 'tuxiesMother' | 'tweester' | 'ukiki' | 'unagi' | 'walkingPenguin' | 'waterBombCannon' | 'wiggler' | 'yoshi' | 'thwomp';

interface IdleBehaviorState {
    kind: IdleBehavior;
    home: vec3;
    position: vec3;
    homeYaw: number;
    yaw: number;
    moveYaw: number;
    targetYaw: number;
    forwardVel: number;
    verticalVel: number;
    scale: number;
    renderScale: number;
    parameter: number;
    action: number;
    sequenceStep: number;
    timer: number;
    walkTimer: number;
    randomSeed: number;
    lastFrame: number;
    visible: boolean;
    facePitch: number;
    faceRoll: number;
    movePitch: number;
    animationIndex: number;
    animationSpeed: number;
    animationFrame: number;
    previousAnimationIndex: number;
    animState: number;
    blinkTimer: number;
    trail: vec3[];
    activationCenter: vec3;
    targetPosition: vec3;
    hasBehaviorTarget: boolean;
    targetHeightOffset: number;
    approachRemaining: number;
    auxiliaryTimer: number;
    activeFromAfar: boolean;
    spawnedByTriplet: boolean;
    spawnedByScuttlebugSpawner: boolean;
    parent?: IdleBehaviorState;
}

function behaviorKind(address: number | undefined): IdleBehavior | undefined {
    if (address === 0x1300472C) return 'goomba';
    if (address === 0x13003174) return 'bobomb';
    if (address === 0x130031DC || address === 0x13003228) return 'bobombBuddy';
    if (address === 0x13001850) return 'bowser';
    if (address === 0x130055DC) return 'bubba';
    if (address === 0x1300362C || address === 0x13003660 || address === 0x13003694 || address === 0x130036C8 || address === 0x13003700) return 'bully';
    if (address === 0x130033BC) return 'butterfly';
    if (address === 0x13005598) return 'tripletButterfly';
    if (address === 0x13005354) return 'bird';
    if (address === 0x130027E4 || address === 0x13002804) return 'boo';
    if (address === 0x130026D4) return 'booInCastle';
    if (address === 0x130027D0) return 'booSpawner';
    if (address === 0x13002710) return 'booWithCage';
    if (address === 0x13002768) return 'balconyBigBoo';
    if (address === 0x13002790) return 'dormantBigBoo';
    if (address === 0x1300478C) return 'chainChomp';
    if (address === 0x13003910) return 'smallBomp';
    if (address === 0x13003940) return 'largeBomp';
    if (address === 0x13005440) return 'clam';
    if (address === 0x13002338) return 'sushi';
    if (address === 0x13004898) return 'wiggler';
    if (address === 0x13002650) return 'tweester';
    if (address === 0x13000054) return 'mrI';
    if (address === 0x13000528) return 'chuckya';
    if (address === 0x13004A00) return 'montyMole';
    if (address === 0x13002E58) return 'walkingPenguin';
    if (address === 0x13005468) return 'skeeter';
    if (address === 0x13004F90) return 'dorrie';
    if (address === 0x13003354) return 'homingAmp';
    if (address === 0x13003388) return 'circlingAmp';
    if (address === 0x130012B4) return 'spindrift';
    if (address === 0x13003B00) return 'spindel';
    if (address === 0x130046DC) return 'flyGuy';
    if (address === 0x13004698) return 'swoop';
    if (address === 0x130051E0) return 'snufit';
    if (address === 0x13002B5C) return 'scuttlebug';
    if (address === 0x13001548) return 'heaveHo';
    if (address === 0x1300525C) return 'horizontalGrindel';
    if (address === 0x13005120) return 'firePiranha';
    if (address === 0x1300518C) return 'fireSpitter';
    if (address === 0x13001650) return 'jumpingBox';
    if (address === 0x13004F10) return 'waterBombCannon';
    if (address === 0x13002160) return 'fish';
    if (address === 0x13001B2C) return 'tankFish';
    if (address === 0x13004918) return 'enemyLakitu';
    if (address === 0x130001F4) return 'kingBobomb';
    if (address === 0x13005310) return 'klepto';
    if (address === 0x13005024) return 'madPiano';
    if (address === 0x130052D0) return 'eyerokHand';
    if (address === 0x13004538) return 'yoshi';
    if (address === 0x13004634) return 'pokey';
    if (address === 0x13004DBC) return 'mrBlizzard';
    if (address === 0x13001FBC) return 'piranhaPlant';
    if (address === 0x13001F90) return 'toxBox';
    if (address === 0x130020E8) return 'smallPenguin';
    if (address === 0x13002088) return 'tuxiesMother';
    if (address === 0x13002BB8) return 'kingWhomp';
    if (address === 0x13002BCC) return 'smallWhomp';
    if (address === 0x13004F40) return 'unagi';
    if (address === 0x13004FD4) return 'hauntedChair';
    if (address === 0x13000F08 || address === 0x13001CB0) return 'ukiki';
    if (address === 0x13004580) return 'koopa';
    if (address === 0x13000B58 || address === 0x13000B8C || address === 0x13000BC8) return 'thwomp';
    return undefined;
}

function isPenguinKind(kind: IdleBehavior): boolean {
    return kind === 'smallPenguin' || kind === 'walkingPenguin' || kind === 'tuxiesMother';
}

function behaviorAnimation(address: number | undefined, model?: number): [number, number] | undefined {
    switch (address) {
        case 0x130001F4: return [0x0500FE30, 5]; // King Bob-omb waiting for Mario
        case 0x13000528: return [0x0800C070, 4]; // Chuckya patrol
        case 0x13001548: return [0x0501534C, 0]; // Heave-Ho
        case 0x13001850: return [0x06057690, 12]; // Bowser waiting for the arena intro
        case 0x13000F08: case 0x13001CB0: return [0x05015784, 9]; // Ukiki idle taunts
        case 0x13001FBC: return [0x0601C31C, 8]; // Sleeping Piranha Plant
        case 0x13005120: return [0x0601C31C, 0]; // Fire Piranha Plant
        case 0x130020E8: case 0x13002E58: return [0x05008B74, 0]; // Penguins
        case 0x13002088: return [0x05008B74, 3]; // Tuxie's mother waiting
        case 0x13002160: return model === 0x67 ? [0x0600E264, 0] : [0x0301C2B0, 0]; // Cyan / blue fish
        case 0x13001B2C: return [0x0301C2B0, 0]; // Castle aquarium fish
        case 0x13002B5C: return [0x06015064, 0]; // Scuttlebug
        case 0x13002EF8: return [0x0600FB58, 6]; // Castle Toad idle
        case 0x13002BB8: case 0x13002BCC: return [0x06020A04, 0]; // Whomps
        case 0x13003174: case 0x130031DC: case 0x13003228: return [0x0802396C, 0]; // Bob-ombs
        case 0x13003354: case 0x13003388: return [0x08004034, 0]; // Amps
        case 0x130033BC: return [0x030056B0, 1]; // Resting butterfly
        case 0x13005598: return [0x030056B0, 0]; // Triplet butterfly wandering
        case 0x1300362C: case 0x13003660: case 0x13003694: return [0x0500470C, 0]; // Bullies
        case 0x130036C8: case 0x13003700: return [0x06003994, 0]; // Chill Bullies
        case 0x13004580: return [0x06011364, 9]; // Koopa
        case 0x130046DC: return [0x08011A64, 0]; // Fly Guy
        case 0x1300472C: return [0x0801DA4C, 0]; // Goomba
        case 0x1300478C: return [0x06025178, 0]; // Chain Chomp
        case 0x13004918: return [0x050144D4, 0]; // Enemy Lakitu
        case 0x13004954: return [0x060058F8, 0]; // Camera Lakitu idle
        case 0x130049C8: return [0x05016EAC, 0]; // Spiny
        case 0x13004A00: return [0x05007248, 3]; // Monty Mole
        case 0x13004DBC: return [0x0500D118, 0]; // Mr. Blizzard
        case 0x13004F40: return [0x05012824, 6]; // Unagi
        case 0x13004F90: return [0x0600F638, 1]; // Dorrie
        case 0x1300506C: return [0x05002540, 0]; // Flying Bookend
        case 0x13005024: return [0x05009B14, 0]; // Mad Piano waiting
        case 0x13004FD4: return [0x05005784, 0]; // Haunted chair
        case 0x130012B4: return [0x05002D68, 0]; // Spindrift
        case 0x13004698: return [0x060070D0, 1]; // Hanging Swoop
        case 0x13005310: return [0x05008CFC, 0]; // Klepto
        case 0x130052D0: return [0x050116E4, 6]; // Eyerok hand asleep
        case 0x130044FC: return [0x06015634, 0]; // Mips waiting for Mario
        case 0x13004538: return [0x05024100, 0]; // Yoshi idle on the roof
        case 0x13005354: case 0x1300565C: case 0x13005680: return [0x050009E8, 0]; // Birds
        case 0x13005380: return [0x05008B74, 3]; // Racing Penguin
        case 0x13005468: return [0x06007DE0, 1]; // Skeeter at the water surface
        case 0x13005440: return [0x05001744, 0]; // Clam opening, then held open
        case 0x13002338: return [0x0500AE54, 0]; // Sushi shark swimming
        case 0x13004898: return [0x0500EC8C, 0]; // Wiggler walking
        case 0x13003C58: return [0x0700C95C, 0]; // Castle flag wave
        default: return undefined;
    }
}

function randomU16(state: IdleBehaviorState): number {
    let seed = state.randomSeed & 0xFFFF;
    if (seed === 22026) seed = 0;
    let temp1 = ((seed & 0x00FF) << 8) ^ seed;
    seed = (((temp1 & 0x00FF) << 8) | ((temp1 & 0xFF00) >>> 8)) & 0xFFFF;
    temp1 = (((temp1 & 0x00FF) << 1) ^ seed) & 0xFFFF;
    const temp2 = ((temp1 >>> 1) ^ 0xFF80) & 0xFFFF;
    seed = (temp1 & 1) === 0 ? (temp2 === 43605 ? 0 : temp2 ^ 0x1FF4) : temp2 ^ 0x8180;
    return state.randomSeed = seed & 0xFFFF;
}

function randomFloat(state: IdleBehaviorState): number { return randomU16(state) / 65536; }

function approachBinang(current: number, target: number, increment: number): number {
    let delta = ((target - current + 0x8000) & 0xFFFF) - 0x8000;
    if (delta > increment) delta = increment;
    else if (delta < -increment) delta = -increment;
    return (current + delta) & 0xFFFF;
}

function makeIdleBehaviorState(object: ObjectInfo, kind: IdleBehavior): IdleBehaviorState {
    const seed = (Math.abs(Math.floor(object.position[0] * 13 + object.position[1] * 7 + object.position[2] * 17 + (object.randomSeedOffset ?? 0) * 7919)) | 1) & 0xFFFF;
    const yaw = Math.round(object.rotation[1] * 0x10000 / 360) & 0xFFFF;
    const behaviorTarget = object.behaviorTarget ?? object.position;
    const state: IdleBehaviorState = {
        kind, home: vec3.fromValues(object.position[0], object.position[1], object.position[2]),
        position: vec3.fromValues(object.position[0], object.position[1], object.position[2]),
        homeYaw: yaw, yaw, moveYaw: yaw, targetYaw: yaw, forwardVel: 0, verticalVel: 0, scale: object.scale ?? 1, renderScale: 1,
        parameter: object.behaviorParameter ?? 0, action: 0, sequenceStep: 0, timer: 0, walkTimer: 0,
        randomSeed: seed, lastFrame: -1,
        visible: kind !== 'booSpawner' && kind !== 'dormantBigBoo',
        facePitch: 0, faceRoll: 0, movePitch: 0,
        animationIndex: 0, animationSpeed: 1, animationFrame: 0, previousAnimationIndex: -1, animState: 0, blinkTimer: 0,
        trail: [],
        activationCenter: vec3.fromValues((object.activationCenter ?? object.position)[0], (object.activationCenter ?? object.position)[1], (object.activationCenter ?? object.position)[2]),
        targetPosition: vec3.fromValues(behaviorTarget[0], behaviorTarget[1], behaviorTarget[2]),
        hasBehaviorTarget: object.behaviorTarget !== undefined,
        targetHeightOffset: 0, approachRemaining: 0, auxiliaryTimer: 0,
        activeFromAfar: object.activeFromAfar ?? false,
        spawnedByTriplet: object.spawnedByTriplet ?? false,
        spawnedByScuttlebugSpawner: object.spawnedByScuttlebugSpawner ?? false,
    };
    // bhvDorrie executes SET_HOME before ADD_FLOAT(oPosX, 2000).
    if (kind === 'dorrie') state.position[0] += 2000;
    // Generic Mr. Blizzards initialize their graphical Y offset underground.
    if (kind === 'mrBlizzard' && state.parameter !== 1) state.position[1] -= 200;
    // bhvUnagi's behavior script applies SCALE(300), and the JRB ship eel
    // initializes with its head angled down inside the opening.
    if (kind === 'unagi') {
        state.scale *= 3;
        if (state.parameter !== 1) state.facePitch = -7600;
    }
    if (kind === 'homingAmp') {
        state.renderScale = 0.1;
        state.targetHeightOffset = state.home[1];
    }
    // oScale is zero-initialized; swoop_act_idle grows it by 0.05 per frame.
    if (kind === 'swoop') state.renderScale = 0;
    // While the Eyerok parent sleeps, both hands continuously play animation
    // six in reverse and otherwise remain in their buried sleep transforms.
    if (kind === 'eyerokHand') {
        state.parameter = (state.parameter << 24) >> 24;
        state.animationIndex = 6;
        state.previousAnimationIndex = 6;
        state.animationSpeed = -1;
        state.animState = 3;
    }
    if (kind === 'klepto' && state.parameter !== 0) state.animState = 2;
    if (kind === 'unagi' && state.parameter === 1) state.animState = 1;
    // bhv_circling_amp_init selects the visible electricity branches in all
    // four geo_switch_anim_state nodes. State zero intentionally omits them.
    if (kind === 'circlingAmp') state.animState = 1;
    if (kind === 'kingWhomp') state.scale *= 2;
    if (kind === 'tuxiesMother') state.scale *= 4;
    if (kind === 'horizontalGrindel') state.yaw = (yaw + 0x4000) & 0xFFFF;
    // oSnufitCircularPeriod is a zero-initialized object field; it is not
    // derived from the placed object's face yaw.
    if (kind === 'snufit') state.targetYaw = 0;
    if (kind === 'smallBomp' || kind === 'largeBomp') {
        // Both variants travel along world X. Their init routines alter
        // different angle fields but leave the visible face at yaw zero.
        state.moveYaw = 0x4000;
        state.yaw = 0;
        state.timer = Math.floor(randomFloat(state) * 100);
    }
    if (kind === 'wiggler') {
        for (let age = 31; age >= 0; age--)
            state.trail.push(vec3.fromValues(state.home[0] - Math.sin(binang(yaw)) * age * 16, state.home[1], state.home[2] - Math.cos(binang(yaw)) * age * 16));
    }
    return state;
}

function updateCyclicBlink(state: IdleBehaviorState, baseCycleLength: number, cycleLengthRange: number, blinkLength: number): void {
    // obj_update_blinking: choose a new countdown when it reaches zero, then
    // show the closed-eye geo branch for the final few frames.
    if (state.blinkTimer !== 0)
        state.blinkTimer--;
    else
        state.blinkTimer = baseCycleLength + Math.floor(randomFloat(state) * cycleLengthRange);
    state.animState = state.blinkTimer > blinkLength ? 0 : 1;
}

function updateRandomBlink(state: IdleBehaviorState): void {
    // curr_obj_random_blink, shared by Bob-ombs and Yoshi, uses a 1/100 start
    // chance followed by the exact open/closed/open/closed 15-frame sequence.
    if (state.blinkTimer === 0) {
        if (Math.floor(randomFloat(state) * 100) === 0) {
            state.animState = 1;
            state.blinkTimer = 1;
        }
    } else {
        state.blinkTimer++;
        if (state.blinkTimer > 5) state.animState = 0;
        if (state.blinkTimer > 10) state.animState = 1;
        if (state.blinkTimer > 15) {
            state.animState = 0;
            state.blinkTimer = 0;
        }
    }
}

function stepIdleBehavior(state: IdleBehaviorState, mario: vec3, collisionFloors: CollisionFloorIndex): void {
    const dxMario = mario[0] - state.position[0], dyMario = mario[1] - state.position[1], dzMario = mario[2] - state.position[2];
    const marioDistance = Math.hypot(dxMario, dyMario, dzMario);
    if (state.kind === 'goomba') {
        if (state.visible) {
            const normalSpeed = 4 / 3 * state.scale;
            state.forwardVel += Math.max(-0.4, Math.min(0.4, normalSpeed - state.forwardVel));
            if (state.action === 1) {
                state.verticalVel -= 8 / 3 * state.scale;
                state.position[1] += state.verticalVel;
                state.yaw = approachBinang(state.yaw, state.targetYaw, 0x800);
                if (state.position[1] <= state.home[1]) {
                    state.position[1] = state.home[1];
                    state.verticalVel = 0;
                    state.action = 0;
                }
            } else if (state.walkTimer > 0) {
                state.walkTimer--;
            } else if ((randomU16(state) & 3) !== 0) {
                state.targetYaw = (state.yaw + (randomU16(state) & 1 ? 0x2000 : -0x2000)) & 0xFFFF;
                state.walkTimer = 100 + Math.floor(100 * randomFloat(state));
            } else {
                state.action = 1;
                state.forwardVel = 0;
                state.verticalVel = 50 / 3 * state.scale;
                state.targetYaw = (state.yaw + (randomU16(state) & 1 ? 0x6000 : -0x6000)) & 0xFFFF;
            }
            if (state.action === 0) state.yaw = approachBinang(state.yaw, state.targetYaw, 0x200);
            const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
            if (Math.hypot(homeDx, homeDz) > 1000)
                state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
            const nextX = state.position[0] + Math.sin(binang(state.yaw)) * state.forwardVel;
            const nextZ = state.position[2] + Math.cos(binang(state.yaw)) * state.forwardVel;
            let canMove = true;
            if (collisionFloors.count > 0) {
                const currentFloor = findCollisionFloor(collisionFloors, state.position[0], state.position[1], state.position[2]);
                const intendedFloor = findCollisionFloor(collisionFloors, nextX, state.position[1], nextZ);
                const floorDelta = currentFloor === null || intendedFloor === null ? -Infinity : intendedFloor.height - currentFloor.height;
                // cur_obj_move_standard(-78) rejects a missing intended floor
                // even while airborne. Its 50-unit ledge and 78-degree slope
                // checks apply once the Goomba is grounded.
                canMove = intendedFloor !== null && (state.action !== 0 ||
                    floorDelta >= -50 && intendedFloor.normalY > Math.cos(78 * Math.PI / 180));
                if (intendedFloor !== null && canMove && state.action === 0) state.position[1] = intendedFloor.height;
                if (!canMove) state.targetYaw = (state.yaw + 0x8000) & 0xFFFF;
            }
            if (canMove) {
                state.position[0] = nextX;
                state.position[2] = nextZ;
            }
            // bhv_goomba_update drives clip zero directly from forward speed;
            // no extra model-space rotation is applied by the game.
            state.animationSpeed = Math.max(1, state.forwardVel / state.scale * 0.4);
        }
    } else if (state.kind === 'bobomb') {
        // bhv_bobomb_loop is inactive outside 4000 units. In its non-chase
        // patrol range it walks at 5 units/frame and turns home when Mario is
        // not within 400 units of its home.
        if (state.parameter === 1) {
            // BOBOMB_BP_STYPE_STATIONARY omits the patrol/chase actions from
            // bobomb_free_loop entirely.
            vec3.copy(state.position, state.home);
            state.forwardVel = 0;
        } else if (marioDistance < 4000) {
            const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
            const marioHomeDistance = Math.hypot(mario[0] - state.home[0], mario[1] - state.home[1], mario[2] - state.home[2]);
            if (marioHomeDistance >= 400)
                state.yaw = approachBinang(state.yaw, Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF, 320);
            state.position[0] += Math.sin(binang(state.yaw)) * 5;
            state.position[2] += Math.cos(binang(state.yaw)) * 5;
        }
    } else if (state.kind === 'bobombBuddy') {
        // Bob-omb Buddies have zero forward velocity in their idle action.
        // They only turn toward Mario inside 1000. The game's 3000-unit
        // distance hide is intentionally omitted by the viewer.
        vec3.copy(state.position, state.home);
        state.forwardVel = 0;
        state.visible = true;
        if (marioDistance < 1000)
            state.yaw = approachBinang(state.yaw, Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF, 0x140);
    } else if (state.kind === 'bowser') {
        // BOWSER_ACT_WAIT holds him at home with zero forward velocity and
        // continuously selects the idle clip until the arena cutscene changes
        // oBowserCamAct. With no simulated cutscene, this is his canonical
        // passive state.
        vec3.copy(state.position, state.home);
        state.forwardVel = 0;
        state.animationIndex = 12;
    } else if (state.kind === 'bubba') {
        // With Mario outside 2000, treat_far_home_as_mario makes Bubba use its
        // normal five-unit wander controller but steer back toward home.
        state.forwardVel += Math.max(-0.5, Math.min(0.5, 5 - state.forwardVel));
        const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
        if (marioDistance >= 2000 || Math.hypot(homeDx, homeDz) > 2000) {
            state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
        } else if (state.walkTimer-- <= 0) {
            state.targetYaw = (state.yaw + (randomU16(state) & 1 ? 0x2000 : -0x2000)) & 0xFFFF;
            state.walkTimer = 100 + Math.floor(100 * randomFloat(state));
        }
        state.yaw = approachBinang(state.yaw, state.targetYaw, 200);
        state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
        state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
    } else if (state.kind === 'boo' || state.kind === 'booWithCage' || state.kind === 'booInCastle') {
        // In action 0, ordinary and cage Boos remain at home without calling
        // boo_oscillate until their room/radius activation condition is met.
        vec3.copy(state.position, state.home);
        state.forwardVel = 0;
    } else if (state.kind === 'balconyBigBoo') {
        // The game's 5000-unit render hide is only an optimization.
        state.visible = true;
        vec3.copy(state.position, state.home);
    } else if (state.kind === 'dormantBigBoo' || state.kind === 'booSpawner') {
        // Ghost-hunt Big Boo waits for five minion deaths. Courtyard triplet is
        // a model-less spawner, not a Boo itself.
        state.visible = false;
    } else if (state.kind === 'bully') {
        // BULLY_ACT_PATROL uses the same home-safety helper as Bob-ombs,
        // with an 800-unit Mario radius and a constant speed of 5.
        const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
        const marioHomeDistance = Math.hypot(mario[0] - state.home[0], mario[1] - state.home[1], mario[2] - state.home[2]);
        if (marioHomeDistance >= 800)
            state.yaw = approachBinang(state.yaw, Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF, 320);
        state.position[0] += Math.sin(binang(state.yaw)) * 5;
        state.position[2] += Math.cos(binang(state.yaw)) * 5;
    } else if (state.kind === 'butterfly') {
        // Butterflies rest at their floor-dropped home in animation 1 until
        // Mario enters a 1000-unit radius; their active follow flight is not a
        // far-Mario idle state.
        vec3.copy(state.position, state.home);
        state.animationIndex = 1;
        state.forwardVel = 0;
    } else if (state.kind === 'tripletButterfly') {
        if (state.action === 0) {
            state.action = 1;
            state.visible = true;
            state.timer = 0;
            const spawnType = state.parameter & 3;
            const baseYaw = Math.round(spawnType * 0x10000 / 3) & 0xFFFF;
            state.yaw = (baseYaw + Math.floor(randomFloat(state) * 0x5555)) & 0xFFFF;
            state.targetYaw = baseYaw;
            state.forwardVel = 15 + Math.floor(randomFloat(state) * 15);
        } else if (state.action === 1) {
            state.forwardVel += Math.max(-0.5, Math.min(0.5, 8 - state.forwardVel));
            if (state.timer < 60) {
                const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
                state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
            } else {
                state.targetYaw = Math.round((state.parameter & 3) * 0x10000 / 3) & 0xFFFF;
            }
            const targetHeight = state.home[1] + 50 + Math.floor(randomFloat(state) * 50);
            state.movePitch = approachBinang(state.movePitch, state.position[1] < targetHeight ? -0x2000 : 0x2000, 400);
            state.yaw = approachBinang(state.yaw, state.targetYaw, 400 + Math.floor(randomFloat(state) * 800));
            const pitch = binang(state.movePitch);
            const horizontalSpeed = Math.cos(pitch) * state.forwardVel;
            state.position[0] += Math.sin(binang(state.yaw)) * horizontalSpeed;
            state.position[1] -= Math.sin(pitch) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.yaw)) * horizontalSpeed;
            state.timer++;
        }
    } else if (state.kind === 'chainChomp') {
        // Keep the body and extracted chain visible outside the gameplay
        // activation radius; unloading them is only a distance optimization.
        state.visible = true;
        if (state.action === 0) {
            if (marioDistance < 3000) {
                state.action = 1;
                state.sequenceStep = 0;
                state.timer = 0;
                vec3.copy(state.position, state.home);
            }
        } else if (marioDistance > 4000) {
            // ACT_MOVE selects UNLOAD_CHAIN above 4000; the following update
            // hides the chomp, frees its links, and returns to uninitialized.
            state.action = 0;
            state.forwardVel = state.verticalVel = 0;
            vec3.copy(state.position, state.home);
        } else {
            state.targetYaw = Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF;
            if (state.sequenceStep === 0) {
                state.moveYaw = approachBinang(state.moveYaw, state.targetYaw, 0x400);
                state.yaw = state.moveYaw;
                const yawError = Math.abs(((state.targetYaw - state.moveYaw + 0x8000) & 0xFFFF) - 0x8000);
                if (yawError < 0x800) {
                    state.forwardVel = 0;
                    if (++state.timer > 40) {
                        state.sequenceStep = 1;
                        state.timer = 0;
                        state.forwardVel = 140;
                        state.verticalVel = 20;
                    }
                } else {
                    state.timer = 0;
                    state.forwardVel = 10;
                    state.verticalVel = 20;
                }
            } else if (state.sequenceStep === 2) {
                state.forwardVel = 0;
                if (--state.timer <= 0) { state.sequenceStep = 0; state.timer = 0; }
            }
            state.verticalVel -= 4;
            state.position[0] += Math.sin(binang(state.moveYaw)) * state.forwardVel;
            state.position[1] += state.verticalVel;
            state.position[2] += Math.cos(binang(state.moveYaw)) * state.forwardVel;
            if (state.position[1] < state.home[1]) { state.position[1] = state.home[1]; state.verticalVel = 0; }
            const lateralDx = state.position[0] - state.home[0], lateralDz = state.position[2] - state.home[2];
            const lateralDistance = Math.hypot(lateralDx, lateralDz);
            if (state.sequenceStep === 1 && lateralDistance >= 900) {
                const scale = 900 / lateralDistance;
                state.position[0] = state.home[0] + lateralDx * scale;
                state.position[2] = state.home[2] + lateralDz * scale;
                state.forwardVel = state.verticalVel = 0;
                state.sequenceStep = 2;
                state.timer = 30;
            }
            state.animationSpeed = state.sequenceStep === 0 && state.timer <= 30 ? 1 : -1;
        }
    } else if (state.kind === 'clam') {
        // Far from Mario, a clam plays its one-shot opening animation and
        // remains open; it only begins the closing attack inside 500 units.
        state.animationIndex = 0;
    } else if (state.kind === 'chuckya') {
        // chuckya_act_0 sub-action 3 is the far-home guard. A displaced
        // Chuckya returns at 10 units/frame and stops within 500 units.
        state.animationIndex = 4;
        const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
        if (Math.hypot(homeDx, homeDz) > 500) {
            state.forwardVel += Math.max(-4, Math.min(4, 10 - state.forwardVel));
            state.yaw = approachBinang(state.yaw, Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF, 0x800);
            state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
        } else {
            state.forwardVel = 0;
        }
    } else if (state.kind === 'montyMole') {
        state.visible = true;
    } else if (state.kind === 'heaveHo') {
        state.visible = true;
        if (state.action === 0) {
            // heave_ho_act_0 resets to home and remains hidden until Mario is
            // within 4000 units and the object is above the water surface.
            vec3.copy(state.position, state.home);
            state.forwardVel = 0;
            if (marioDistance < 4000) {
                state.action = 1;
                state.timer = 0;
                state.animationIndex = 2;
            }
        } else if (state.action === 1) {
            state.forwardVel = 0;
            state.animationIndex = 2;
            const sequence = [[30, 0], [42, 1], [52, 0], [64, 1], [74, 0], [86, 1], [96, 0], [108, 1], [118, 0]];
            const entry = sequence.find(([end]) => state.timer < end);
            if (entry === undefined) {
                state.action = 2;
                state.timer = 0;
                state.animationIndex = 0;
                state.animationSpeed = 1;
            } else {
                // cur_obj_reverse_animation followed by animation accel zero
                // or one produces reverse playback or a held frame.
                state.animationSpeed = entry[1] - 1;
                state.timer++;
            }
        } else {
            // heave_ho_act_2 pursues Mario for 150 frames, then slows linearly
            // until it returns to the wind-up sequence at a 0.1 multiplier.
            const speedScale = state.timer > 150 ? Math.max(0.1, (302 - state.timer) / 152) : 1;
            state.animationIndex = 0;
            state.animationSpeed = speedScale;
            state.forwardVel = speedScale * 10;
            const marioHomeDistance = Math.hypot(mario[0] - state.home[0], mario[2] - state.home[2]);
            state.targetYaw = marioHomeDistance > 1000
                ? Math.atan2(state.home[0] - state.position[0], state.home[2] - state.position[2]) * 0x8000 / Math.PI & 0xFFFF
                : Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF;
            state.yaw = approachBinang(state.yaw, state.targetYaw, Math.round(speedScale * 0x400));
            state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
            state.timer++;
            if (speedScale <= 0.1) {
                state.action = 1;
                state.timer = 0;
                state.animationIndex = 2;
            }
        }
    } else if (state.kind === 'firePiranha') {
        state.visible = true;
        state.timer++;
    } else if (state.kind === 'horizontalGrindel') {
        // This subtype waits on the floor, jumps 11 units/frame along its
        // movement yaw, then turns around after landing more than 300 from
        // home. Its graphical yaw is always a quarter turn from movement.
        if (state.action === 0) {
            state.moveYaw = approachBinang(state.moveYaw, state.targetYaw, 0x400);
            state.yaw = (state.moveYaw + 0x4000) & 0xFFFF;
            if (state.moveYaw !== state.targetYaw) {
                state.timer = 0;
            } else if (state.timer > 60) {
                if (state.sequenceStep !== 0) {
                    state.targetYaw = (state.targetYaw + 0x8000) & 0xFFFF;
                    state.sequenceStep = 0;
                    state.timer = 0;
                } else {
                    state.action = 1;
                    state.timer = 0;
                    state.forwardVel = 11;
                    state.verticalVel = 70;
                }
            } else {
                state.timer++;
            }
        } else {
            state.verticalVel = Math.max(-78, state.verticalVel + (state.verticalVel < 0 ? -16 : -4));
            state.position[0] += Math.sin(binang(state.moveYaw)) * state.forwardVel;
            state.position[1] += state.verticalVel;
            state.position[2] += Math.cos(binang(state.moveYaw)) * state.forwardVel;
            if (state.verticalVel < 0 && state.position[1] <= state.home[1]) {
                state.position[1] = state.home[1];
                state.forwardVel = state.verticalVel = 0;
                state.sequenceStep = Math.hypot(state.position[0] - state.home[0], state.position[2] - state.home[2]) > 300 ? 1 : 0;
                state.action = 0;
                state.timer = 0;
            }
        }
    } else if (state.kind === 'enemyLakitu') {
        // Lakitu is hidden only until his first activation. Afterwards
        // treat_far_home_as_mario keeps him flying even when Mario leaves: he
        // follows Mario while inside his 2000-unit home leash and turns back
        // toward home only after crossing it.
        state.visible = true;
        if (state.action === 0) {
            state.animationIndex = 0;
            if (marioDistance < 2000) {
                state.action = 1;
            }
        } else {
            const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
            const homeDistance = vec3.distance(state.position, state.home);
            const marioHomeDistance = vec3.distance(mario, state.home);
            let behaviorDistance = marioDistance;
            if (homeDistance > 2000) {
                state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
                behaviorDistance = 25000;
            } else {
                state.targetYaw = Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF;
                if (marioHomeDistance > 2000) behaviorDistance = 20000;
            }
            const clampedDistance = Math.min(behaviorDistance, 500);
            state.forwardVel = Math.max(8, Math.min(40, clampedDistance * 0.04));
            const targetVerticalVel = state.position[1] < mario[1] + 300 + (state.verticalVel < 0 ? -3 : 3) ? 4 : -4;
            state.verticalVel += Math.max(-0.4, Math.min(0.4, targetVerticalVel - state.verticalVel));
            const turnSpeed = Math.max(200, Math.min(4000, clampedDistance * 2));
            state.moveYaw = approachBinang(state.moveYaw, state.targetYaw, turnSpeed);
            state.yaw = approachBinang(state.yaw, state.targetYaw, 0x600);
            state.position[0] += Math.sin(binang(state.moveYaw)) * state.forwardVel;
            state.position[1] += state.verticalVel;
            state.position[2] += Math.cos(binang(state.moveYaw)) * state.forwardVel;
            state.animationIndex = 1;
        }
    } else if (state.kind === 'kingBobomb') {
        // Before the introductory dialog, King Bob-omb is reset to home and
        // waits in animation 5. The game's 5000-unit render hide is omitted.
        state.visible = true;
        state.animationIndex = 5;
        vec3.copy(state.position, state.home);
        state.forwardVel = 0;
    } else if (state.kind === 'madPiano') {
        // MAD_PIANO_ACT_WAIT continuously plays clip zero. It does not move
        // until Mario has remained within 500 units while running quickly;
        // there is no autonomous movement in the no-Mario state.
        state.animationIndex = 0;
        state.forwardVel = 0;
        vec3.copy(state.position, state.home);
        state.yaw = state.homeYaw;
    } else if (state.kind === 'fireSpitter') {
        // fire_spitter_act_idle approaches the graphical scale from the
        // behavior default of one to 0.2 by exactly 0.002 per 30 Hz frame.
        state.renderScale += Math.max(-0.002, Math.min(0.002, 0.2 - state.renderScale));
        state.forwardVel = 0;
        vec3.copy(state.position, state.home);
    } else if (state.kind === 'jumpingBox') {
        // jumping_box_free_update moves first, then starts another hop as soon
        // as the box is grounded. The behavior's physics value -400 is -4
        // world units/frame², and each jump begins at random 15..20 velocity.
        if (state.position[1] > state.home[1] || state.verticalVel > 0) {
            state.position[1] += state.verticalVel;
            state.verticalVel -= 4;
            if (state.position[1] <= state.home[1]) {
                state.position[1] = state.home[1];
                state.verticalVel = 0;
            }
        }
        if (state.position[1] === state.home[1] && state.verticalVel === 0)
            state.verticalVel = 15 + 5 * randomFloat(state);
    } else if (state.kind === 'waterBombCannon') {
        // Keep the complete cannon visible; its activation radius controls
        // firing state, not whether the viewer draws the extracted model.
        state.visible = true;
        if (state.action === 0) {
            if (marioDistance < 2000) state.action = 1;
        } else if (state.action === 1) {
            if (marioDistance > 2500) state.action = 2;
        } else {
            state.action = 0;
        }
    } else if (state.kind === 'klepto') {
        // The SSL Klepto is the star-carrying variant, so it starts in
        // CIRCLE_TARGET_HOLDING and never waits for Mario. These are the exact
        // three homes and the circle/approach controller from klepto.inc.c.
        const targets = [
            vec3.fromValues(2200, 1250, -2820),
            vec3.fromValues(-6200, 1250, -2800),
            vec3.fromValues(-6200, 1250, 1150),
        ];
        const targetDx = state.targetPosition[0] - state.position[0];
        const targetDz = state.targetPosition[2] - state.position[2];
        const targetDistance = Math.hypot(targetDx, targetDz);
        const yawToTarget = Math.atan2(targetDx, targetDz) * 0x8000 / Math.PI & 0xFFFF;
        const pitchToTarget = Math.atan2(state.position[1] - state.targetPosition[1], targetDistance) * 0x8000 / Math.PI & 0xFFFF;
        state.targetYaw = yawToTarget;

        const changeTarget = (): void => {
            let targetIndex: number;
            if (marioDistance > 2000) {
                targetIndex = 0;
                let closest = Infinity;
                for (let i = 0; i < targets.length; i++) {
                    const distance = Math.hypot(mario[0] - targets[i][0], mario[2] - targets[i][2]);
                    if (distance < closest) { closest = distance; targetIndex = i; }
                }
            } else {
                targetIndex = randomU16(state) % 3;
            }
            state.targetHeightOffset = 400 * Math.abs(targetIndex - state.sequenceStep);
            state.sequenceStep = targetIndex;
            vec3.copy(state.targetPosition, targets[targetIndex]);
            state.targetPosition[1] += state.targetHeightOffset;
            state.approachRemaining = vec3.distance(
                vec3.fromValues(state.position[0], 0, state.position[2]),
                vec3.fromValues(state.targetPosition[0], 0, state.targetPosition[2]),
            ) / 2;
        };

        if (state.action === 0) { // KLEPTO_ACT_CIRCLE_TARGET_HOLDING
            if ((state.timer > 60 && marioDistance > 2000) || state.timer >= state.walkTimer) {
                changeTarget();
                state.walkTimer = 300 + Math.floor(300 * randomFloat(state));
                state.action = 1;
                state.timer = 0;
            } else {
                let turnAmount = 0x4000 - Math.atan2(300, targetDistance - 300) * 0x8000 / Math.PI;
                const signedMoveError = ((state.moveYaw - yawToTarget + 0x8000) & 0xFFFF) - 0x8000;
                if (signedMoveError < 0) turnAmount = -turnAmount;
                state.targetYaw = (yawToTarget + turnAmount) & 0xFFFF;
                const yawError = Math.abs(((state.targetYaw - state.moveYaw + 0x8000) & 0xFFFF) - 0x8000);
                const turnSpeed = Math.max(400, Math.min(700, Math.trunc(yawError * (0.03 * state.forwardVel))));
                state.moveYaw = approachBinang(state.moveYaw, state.targetYaw, turnSpeed);
                const accel = state.forwardVel > 50 ? 2 : 0.05;
                state.forwardVel += Math.max(-accel, Math.min(accel, 40 - state.forwardVel));
            }
        } else { // KLEPTO_ACT_APPROACH_TARGET_HOLDING
            if (targetDistance < 1800) {
                state.action = 0;
                state.timer = 0;
            } else {
                if (state.approachRemaining > 0 && (state.approachRemaining -= state.forwardVel) <= 0)
                    state.targetPosition[1] -= state.targetHeightOffset;
                state.moveYaw = approachBinang(state.moveYaw, yawToTarget, 400);
                state.forwardVel += Math.max(-0.05, Math.min(0.05, 50 - state.forwardVel));
            }
        }

        // klepto_anim_dive alternates the normal flap with clips six and five,
        // using oKleptoUnk1AE to insert 60..119-frame shallow-flight phases.
        const signedTargetPitch = ((pitchToTarget + 0x8000) & 0xFFFF) - 0x8000;
        if (state.auxiliaryTimer > 0) {
            if (signedTargetPitch < -400) {
                state.auxiliaryTimer = 0;
            } else if (state.animationIndex === 0) {
                if (Math.floor(state.animationFrame) === 9) state.animationIndex = 6;
            } else if (--state.auxiliaryTimer === 0) {
                state.auxiliaryTimer = -(60 + Math.floor(60 * randomFloat(state)));
            }
            state.verticalVel = approachBinang(state.verticalVel, 400, 10);
        } else {
            state.verticalVel = approachBinang(state.verticalVel, pitchToTarget, 600);
            if (state.animationIndex === 6 && state.animationFrame >= 7) {
                state.animationIndex = 5;
            } else if (state.animationIndex === 5 && state.animationFrame >= 7) {
                state.animationIndex = 0;
            } else if (state.animationIndex === 0) {
                if (state.auxiliaryTimer !== 0) state.auxiliaryTimer++;
                else if (signedTargetPitch > -100) state.auxiliaryTimer = 60 + Math.floor(60 * randomFloat(state));
            }
        }
        const pitch = binang(state.verticalVel);
        state.position[0] += Math.cos(pitch) * Math.sin(binang(state.moveYaw)) * state.forwardVel;
        state.position[1] -= Math.sin(pitch) * state.forwardVel;
        state.position[2] += Math.cos(pitch) * Math.cos(binang(state.moveYaw)) * state.forwardVel;
        state.yaw = state.moveYaw;
        const rollError = ((state.moveYaw - state.targetYaw + 0x8000) & 0xFFFF) - 0x8000;
        state.faceRoll = approachBinang(state.faceRoll, Math.max(-0x3000, Math.min(0x3000, rollError)) & 0xFFFF, 600);
        state.facePitch = approachBinang(state.facePitch, 0, 1000);
        state.timer++;
    } else if (state.kind === 'mrBlizzard') {
        if (state.parameter !== 1) {
            // Generic and cap variants remain hidden 200 units below the floor
            // until Mario comes inside 1000 units.
            state.visible = marioDistance < 1000;
            state.position[1] = state.home[1] - (state.visible ? 0 : 200);
            state.animationIndex = 0;
        } else {
            // The CCM jumping subtype autonomously waits 15 frames, leaps at
            // 10 forward / 50 upward, and turns back after traveling 700 units.
            state.visible = true;
            if (state.action === 0) {
                state.forwardVel = 0;
                if (state.timer++ >= 15) {
                    const homeDistance = Math.hypot(state.position[0] - state.home[0], state.position[2] - state.home[2]);
                    if (homeDistance > 700) {
                        state.targetYaw = (state.targetYaw + 0x8000) & 0xFFFF;
                        state.action = 2; state.timer = 30; state.verticalVel = 25;
                    } else {
                        state.action = 1; state.timer = 0; state.forwardVel = 10; state.verticalVel = 50;
                    }
                }
            } else if (state.action === 1) {
                state.yaw = approachBinang(state.yaw, state.targetYaw, 3400);
                state.verticalVel -= 4;
                state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
                state.position[1] += state.verticalVel;
                state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
                if (state.position[1] <= state.home[1]) {
                    state.position[1] = state.home[1]; state.verticalVel = 0;
                    state.action = 0; state.timer = 0;
                }
            } else {
                state.yaw = approachBinang(state.yaw, state.targetYaw, 3400);
                state.verticalVel -= 4;
                state.position[1] = Math.max(state.home[1], state.position[1] + state.verticalVel);
                if (--state.timer <= 0) {
                    state.action = 1; state.forwardVel = 10; state.verticalVel = 50;
                }
            }
            state.animationIndex = 0;
        }
    } else if (state.kind === 'mrI') {
        // Mr. I action 0 resets to home with zero angles outside its 1500-unit
        // activation radius.
        vec3.copy(state.position, state.home);
        state.yaw = 0;
        state.facePitch = 0;
    } else if (state.kind === 'piranhaPlant') {
        // Action 0 is the far-Mario state: remain planted at home and sleep.
        vec3.copy(state.position, state.home);
        state.animationIndex = 8;
        state.forwardVel = 0;
    } else if (state.kind === 'smallPenguin') {
        // small_penguin_act_0 uses the standing/yelling clip. If the object is
        // considered far away it is reset to home every frame.
        state.animationIndex = 3;
        state.forwardVel = 0;
        if (marioDistance >= 1000) vec3.copy(state.position, state.home);
    } else if (state.kind === 'smallBomp' || state.kind === 'largeBomp') {
        // The WF Bomps share an absolute X-axis cycle. Movement from the
        // behavior flag occurs after the action function, so newly selected
        // velocities take effect on the transition frame.
        if (state.action === 0) {
            if (state.timer > 100) { state.action = 1; state.forwardVel = 30; state.timer = -1; }
        } else if (state.action === 1) {
            if (state.position[0] > 3450) { state.position[0] = 3450; state.forwardVel = 0; }
            if (state.timer === 15) {
                state.action = 2;
                state.forwardVel = state.kind === 'smallBomp' ? 40 : 10;
                state.timer = -1;
            }
        } else if (state.action === 2) {
            if (state.position[0] > 3830) { state.position[0] = 3830; state.forwardVel = 0; }
            if (state.timer === 60) {
                state.action = 3;
                state.forwardVel = 10;
                state.moveYaw = (state.moveYaw + 0x8000) & 0xFFFF;
                state.timer = -1;
            }
        } else {
            if (state.position[0] < 3330) { state.position[0] = 3330; state.forwardVel = 0; }
            if (state.timer === 90) {
                state.action = 1;
                state.forwardVel = 25;
                state.moveYaw = (state.moveYaw + 0x8000) & 0xFFFF;
                state.timer = -1;
            }
        }
        state.position[0] += Math.sin(binang(state.moveYaw)) * state.forwardVel;
        state.position[2] += Math.cos(binang(state.moveYaw)) * state.forwardVel;
        state.timer++;
    } else if (state.kind === 'tuxiesMother') {
        // Her pre-dialog action scales to 4 and waits in animation 3. She only
        // moves after Mario returns a penguin, which is outside idle viewing.
        vec3.copy(state.position, state.home);
        state.animationIndex = 3;
        state.forwardVel = 0;
    } else if (state.kind === 'smallWhomp') {
        // Small Whomps remain in whomp_init until Mario enters 500 units. The
        // walking clip still advances, but position is continually reset home.
        state.animationIndex = 0;
        state.forwardVel = 0;
        vec3.copy(state.position, state.home);
        state.visible = true;
    } else if (state.kind === 'kingWhomp') {
        // Before Mario enters 600 units, whomp_init resets the boss to home,
        // holds animation 0, and applies the behavior's 2x scale.
        state.animationIndex = 0;
        state.forwardVel = 0;
        vec3.copy(state.position, state.home);
        state.visible = true;
    } else if (state.kind === 'unagi') {
        // The parameter-0 JRB eel waits in action 0 with animation 6 and its
        // initial downward pitch. Its tail subobjects trigger departure only
        // after Mario enters the ship, so the far state is stationary.
        vec3.copy(state.position, state.home);
        state.animationIndex = 6;
        state.forwardVel = 0;
        state.facePitch = state.parameter === 1 ? 0 : -7600;
    } else if (state.kind === 'hauntedChair') {
        if (state.hasBehaviorTarget) {
            // bhv_haunted_chair_init selects pitch or roll according to which
            // side of the nearby piano the chair occupies, then action zero
            // runs the exact oscillate_toward parameters every frame.
            if (state.timer === 0) {
                const targetDx = state.targetPosition[0] - state.position[0];
                const targetDz = state.targetPosition[2] - state.position[2];
                const angleToPiano = Math.atan2(targetDx, targetDz) * 0x8000 / Math.PI & 0xFFFF;
                const relativeAngle = ((angleToPiano - state.yaw + 0x2000 + 0x8000) & 0xFFFF) - 0x8000;
                if ((relativeAngle & 0x4000) !== 0) {
                    state.sequenceStep = 1;
                    state.targetYaw = relativeAngle > 0 ? 0x4000 : -0x4000;
                } else {
                    state.sequenceStep = 0;
                    state.targetYaw = relativeAngle < 0 ? 0x5000 : -0x4000;
                }
                state.verticalVel = state.targetYaw < 0 ? -1500 : 1500;
                state.timer = 1;
            } else {
                const isRoll = state.sequenceStep === 1;
                const oldAngle = isRoll ? state.faceRoll : state.facePitch;
                let angle = oldAngle + Math.trunc(state.verticalVel);
                const targetAngle = state.targetYaw;
                if (angle === targetAngle || ((angle - targetAngle) * (oldAngle - targetAngle) < 0 && Math.abs(state.verticalVel) < 4000)) {
                    angle = targetAngle;
                    state.verticalVel = 0;
                } else {
                    let acceleration = angle >= targetAngle ? -20 : 20;
                    if (state.verticalVel * acceleration < 0) acceleration *= 2;
                    state.verticalVel += acceleration;
                }
                if (isRoll) state.faceRoll = angle;
                else state.facePitch = angle;
            }
        } else {
            // Parentless macro chairs hold this pose while Mario is absent.
            state.facePitch = state.faceRoll = 0;
        }
        state.animationIndex = 0;
    } else if (state.kind === 'ukiki') {
        // A far cap Ukiki is reset to home, then idle_ukiki_taunt chooses
        // itch, screech, jump-clap, or handstand sequences at random.
        vec3.copy(state.position, state.home);
        state.forwardVel = 0;
        if (state.timer <= 0) {
            const clips = [9, 4, 5, 10];
            const clipFrames = [100, 10, 16, 85];
            const choice = randomU16(state) & 3;
            state.animationIndex = clips[choice];
            if (choice === 1)
                state.timer = clipFrames[choice] * (4 + 2 * Math.floor(4 * randomFloat(state)));
            else if (choice === 2)
                state.timer = clipFrames[choice] * (2 + Math.floor(4 * randomFloat(state)));
            else
                state.timer = clipFrames[choice];
        }
        state.timer--;
    } else if (state.kind === 'tweester') {
        // TWEESTER_SUB_ACT_WAIT holds scale at zero and resets to home until
        // Mario enters 1500 units.
        state.visible = marioDistance < 1500;
        vec3.copy(state.position, state.home);
    } else if (state.kind === 'homingAmp') {
        const marioHomeDistance = vec3.distance(mario, state.home);
        if (state.action === 0) { // HOMING_AMP_ACT_INACTIVE
            state.visible = false;
            if (marioHomeDistance < 800) {
                state.action = 1;
                state.visible = true;
                state.timer = 0;
            }
        } else if (state.action === 1) { // HOMING_AMP_ACT_APPEAR
            state.visible = true;
            const angleToMario = Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF;
            state.moveYaw = approachBinang(state.moveYaw, angleToMario, 0x1000);
            state.yaw = state.moveYaw;
            if (state.timer < 30) {
                state.renderScale = 0.1 + 0.9 * state.timer / 30;
            } else {
                state.animState = 1;
            }
            if (state.timer > 90) {
                state.renderScale = 1;
                state.action = 2;
                state.timer = 0;
                state.walkTimer = 0;
                state.targetHeightOffset = state.home[1];
            } else {
                state.timer++;
            }
        } else if (state.action === 2) { // HOMING_AMP_ACT_CHASE
            const angleToMario = Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF;
            const angleError = Math.abs(((angleToMario - state.moveYaw + 0x8000) & 0xFFFF) - 0x8000);
            if (angleError < 0x400) {
                state.sequenceStep = 1;
                state.timer = 0;
            }
            if (state.sequenceStep === 1) {
                state.forwardVel = 15;
                const targetY = mario[1] + 150;
                if (state.targetHeightOffset > targetY) state.targetHeightOffset -= 10;
                else state.targetHeightOffset = targetY;
                if (state.timer > 30) state.sequenceStep = 0;
            } else {
                state.forwardVel = 10;
                state.moveYaw = approachBinang(state.moveYaw, angleToMario, 0x400);
                if (state.targetHeightOffset < mario[1] + 250) state.targetHeightOffset += 10;
            }
            state.yaw = state.moveYaw;
            state.position[1] = state.targetHeightOffset + Math.sin(binang(state.walkTimer * 0x400)) * 20;
            state.position[0] += Math.sin(binang(state.moveYaw)) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.moveYaw)) * state.forwardVel;
            state.timer++;
            if (marioHomeDistance >= 1500) {
                state.action = 3;
                state.timer = 0;
            }
        } else { // HOMING_AMP_ACT_GIVE_UP
            state.forwardVel = 15;
            state.position[0] += Math.sin(binang(state.moveYaw)) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.moveYaw)) * state.forwardVel;
            if (state.timer > 150) {
                vec3.copy(state.position, state.home);
                state.visible = false;
                state.action = 0;
                state.animState = 0;
                state.forwardVel = 0;
                state.renderScale = 0.1;
                state.targetHeightOffset = state.home[1];
                state.timer = 0;
            } else {
                state.timer++;
            }
        }
        state.walkTimer++;
    } else if (state.kind === 'circlingAmp') {
        const radii = [200, 300, 400, 0];
        const radius = radii[state.parameter & 3];
        if (radius === 0) {
            // The fixed subtype does not use its randomized orbit angle. It
            // tracks Mario with both face angles while bobbing at its home.
            state.targetYaw = Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF;
            state.yaw = approachBinang(state.yaw, state.targetYaw, 0x1000);
            const lateralDistance = Math.hypot(dxMario, dzMario);
            const targetPitch = Math.atan2(-(dyMario + 120), lateralDistance) * 0x8000 / Math.PI & 0xFFFF;
            state.facePitch = approachBinang(state.facePitch, targetPitch, 0x1000);
            state.position[0] = state.home[0];
            state.position[2] = state.home[2];
            state.position[1] = state.home[1] + Math.cos(binang(state.timer * 0x458)) * 20;
        } else {
            if (state.timer === 0) state.targetYaw = randomU16(state);
            state.position[0] = state.home[0] + Math.sin(binang(state.targetYaw)) * radius;
            state.position[2] = state.home[2] + Math.cos(binang(state.targetYaw)) * radius;
            state.position[1] = state.home[1] + Math.cos(binang(state.timer * 0x8B0)) * 30;
            state.targetYaw = (state.targetYaw + 0x400) & 0xFFFF;
            state.yaw = (state.targetYaw + 0x4000) & 0xFFFF;
        }
        state.timer++;
    } else if (state.kind === 'koopa') {
        const agility = state.parameter === 4 ? 1.6 / 3 : 1;
        if (state.action === 0) {
            state.animationIndex = 7; state.animationSpeed = 1; state.forwardVel = 0;
            if (state.timer++ >= 59) {
                state.action = 1; state.sequenceStep = 0; state.timer = 0;
                state.targetYaw = (state.yaw + (randomU16(state) & 1 ? 0x2000 : -0x2000)) & 0xFFFF;
            }
        } else if (state.sequenceStep === 0) {
            state.animationIndex = 11; state.animationSpeed = 1;
            state.forwardVel += Math.max(-0.3 * agility, Math.min(0.3 * agility, 3 * agility - state.forwardVel));
            if (state.timer++ >= 33) {
                state.sequenceStep = 1; state.timer = 30 + Math.floor(100 * randomFloat(state));
            }
        } else if (state.sequenceStep === 1) {
            state.animationIndex = 9; state.animationSpeed = 1;
            if (state.timer-- <= 0) { state.sequenceStep = 2; state.timer = 0; }
        } else {
            state.animationIndex = 10; state.animationSpeed = 1;
            state.forwardVel += Math.max(-agility, Math.min(agility, -state.forwardVel));
            if (state.timer++ >= 13) { state.action = 0; state.timer = 0; }
        }
        const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
        if (Math.hypot(homeDx, homeDz) > 1000)
            state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
        state.yaw = approachBinang(state.yaw, state.targetYaw, 0x200);
        state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
        state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
    } else if (state.kind === 'snufit') {
        state.targetYaw = (state.targetYaw + 400) & 0xFFFF;
        state.yaw = (state.yaw + 200) & 0xFFFF;
        state.position[0] = state.home[0] + 100 * Math.cos(binang(state.targetYaw));
        state.position[1] = state.home[1] + 8 * Math.cos(binang(state.timer * 4000));
        state.position[2] = state.home[2] + 100 * Math.sin(binang(state.targetYaw));
        state.timer++;
    } else if (state.kind === 'scuttlebug') {
        if (state.spawnedByScuttlebugSpawner && state.action === 0) {
            state.visible = false;
            // The parent waits at least 31 frames and spawns only within this
            // annulus; the child inherits the parent's position and yaw.
            if (state.timer > 30 && marioDistance > 500 && marioDistance < 1500) {
                state.visible = true;
                state.action = 1;
                state.timer = 0;
                state.forwardVel = 30;
                state.verticalVel = 80;
                state.animationSpeed = 3;
            } else {
                state.timer++;
            }
        } else if (state.spawnedByScuttlebugSpawner && state.action === 1) {
            // SET_OBJ_PHYSICS gravity -400 is -4 world units per game frame.
            state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
            state.position[1] += state.verticalVel;
            state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
            state.verticalVel -= 4;
            state.timer++;
            if (state.timer > 1 && state.position[1] <= state.home[1]) {
                state.position[1] = state.home[1];
                state.verticalVel = 0;
                state.forwardVel = 5;
                state.action = 2;
                state.animationSpeed = 1;
                // Sub-action zero establishes the landing point as its home.
                vec3.copy(state.home, state.position);
            }
        } else {
            state.forwardVel = 5;
            const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
            if (Math.hypot(mario[0] - state.home[0], mario[2] - state.home[2]) > 1000)
                state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
            else
                state.targetYaw = Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF;
            state.yaw = approachBinang(state.yaw, state.targetYaw, 0x200);
            state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
        }
    } else if (state.kind === 'spindrift') {
        state.forwardVel += Math.max(-1, Math.min(1, 4 - state.forwardVel));
        const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
        if (Math.hypot(mario[0] - state.home[0], mario[2] - state.home[2]) > 1000)
            state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
        state.yaw = approachBinang(state.yaw, state.targetYaw, 0x400);
        state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
        state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
    } else if (state.kind === 'spindel') {
        // Spindel advances through twenty speed bands, pauses for 32 frames,
        // then traverses the same path in reverse. sequenceStep mirrors
        // oSpindelUnkF4 and action is its direction toggle.
        if (state.sequenceStep === -1) {
            if (state.timer === 32) {
                state.sequenceStep = 0;
                state.timer = 0;
            } else {
                state.timer++;
            }
        }
        if (state.sequenceStep !== -1) {
            let speedBand = Math.max(0, Math.abs(10 - state.sequenceStep) - 6);
            if (state.timer === speedBand + 8) {
                state.timer = 0;
                state.sequenceStep++;
                if (state.sequenceStep === 20) {
                    state.action ^= 1;
                    state.sequenceStep = -1;
                }
            }
            if (speedBand === 3 || speedBand === 4) speedBand = 4;
            else if (speedBand === 1 || speedBand === 2) speedBand = 2;
            else if (speedBand === 0) speedBand = 1;
            if (state.timer < speedBand * 8) {
                const direction = state.action === 0 ? 1 : -1;
                state.position[2] += direction * 20 / speedBand;
                state.facePitch = (state.facePitch + direction * 1024 / speedBand) & 0xFFFF;
                state.position[1] = state.home[1] + Math.abs(Math.sin(binang(state.facePitch * 4))) * 23;
            }
            state.timer++;
        }
    } else if (state.kind === 'sushi') {
        // Sushi sharks circle continuously, independent of Mario.
        const phase = state.timer * 0x80;
        state.position[0] = state.home[0] + Math.sin(binang(phase)) * 1700;
        state.position[1] = state.home[1] + Math.sin(binang(phase)) * 200;
        state.position[2] = state.home[2] + Math.cos(binang(phase)) * 1700;
        state.yaw = (phase + 0x4000) & 0xFFFF;
        state.timer++;
    } else if (state.kind === 'fish') {
        const activationDistance = vec3.distance(mario, state.activationCenter);
        state.visible = true;
        if (state.visible) {
            if (state.timer === 0) {
                state.forwardVel = 3 + 2 * randomFloat(state);
                state.walkTimer = Math.floor((state.activeFromAfar || activationDistance >= 1500 ? 700 : 100) * randomFloat(state));
            }
            const dx = mario[0] - state.position[0], dz = mario[2] - state.position[2];
            state.targetYaw = Math.atan2(dx, dz) * 0x8000 / Math.PI & 0xFFFF;
            state.yaw = approachBinang(state.yaw, state.targetYaw, 0x400);
            state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
            const targetY = mario[1] + state.walkTimer;
            state.position[1] += Math.max(-4, Math.min(4, targetY - state.position[1]));
            state.animationIndex = 0;
            state.animationSpeed = state.timer < 10 ? 2 : 1;
            state.timer++;
        }
    } else if (state.kind === 'tankFish') {
        // The room gate is omitted so the aquarium schools remain visible.
        state.visible = true;
        if (state.visible) {
            if (state.action === 0) {
                if (state.timer === 0) {
                    state.targetYaw = randomU16(state) & 1 ? 0x800 : -0x800;
                    state.forwardVel = 3 + 2 * randomFloat(state);
                    state.walkTimer = (Math.floor(30 * randomFloat(state)) & 0xFE) + 60;
                    state.verticalVel = randomFloat(state) * 5 < 2 ? (randomFloat(state) * 256 - 128) : 0;
                }
                state.animationSpeed = 1;
                if (state.timer < state.walkTimer / 2) state.facePitch += state.verticalVel;
                else state.facePitch -= state.verticalVel;
                if (++state.timer >= state.walkTimer) { state.action = 1; state.timer = 0; }
            } else if (state.action === 1) {
                state.animationSpeed = 2;
                state.yaw = (state.yaw + state.targetYaw) & 0xFFFF;
                if (++state.timer >= 15) { state.action = 2; state.timer = 0; }
            } else if (state.action === 2) {
                state.animationSpeed = 1;
                if (state.timer < state.walkTimer / 2) state.facePitch -= state.verticalVel;
                else state.facePitch += state.verticalVel;
                if (++state.timer >= state.walkTimer) { state.action = 3; state.timer = 0; }
            } else {
                state.animationSpeed = 2;
                state.yaw = (state.yaw + state.targetYaw) & 0xFFFF;
                if (++state.timer >= 15) { state.action = 0; state.timer = 0; }
            }
            const pitch = binang(state.facePitch);
            state.position[0] += Math.cos(pitch) * Math.sin(binang(state.yaw)) * state.forwardVel;
            state.position[1] -= Math.sin(pitch) * state.forwardVel;
            state.position[2] += Math.cos(pitch) * Math.cos(binang(state.yaw)) * state.forwardVel;
            state.animationIndex = 0;
        }
    } else if (state.kind === 'flyGuy') {
        // treat_far_home_as_mario(2000) substitutes the home point whenever
        // Mario is far from the spawn. The normal idle action then turns to
        // that point and enters APPROACH_MARIO; that action accelerates to 10
        // units/frame and keeps steering home rather than hovering in place.
        const marioHomeDistance = Math.hypot(mario[0] - state.home[0], mario[2] - state.home[2]);
        if (marioHomeDistance >= 2000) {
            const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
            state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
            if (state.action === 0) {
                state.forwardVel = 0;
                state.yaw = approachBinang(state.yaw, state.targetYaw, 0x300);
                if (state.yaw === state.targetYaw) state.action = 1;
            } else {
                state.forwardVel += Math.max(-0.5, Math.min(0.5, 10 - state.forwardVel));
                state.yaw = approachBinang(state.yaw, state.targetYaw, 0x200);
                state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
                state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
            }
        }
        state.position[1] += Math.cos(binang(state.timer * 0x400)) * 1.5;
        state.timer++;
    } else if (state.kind === 'swoop') {
        // Idle Swoops hang at home and play animation 1 upside-down until
        // Mario enters their 1500-unit activation radius.
        state.animationIndex = 1;
        state.faceRoll = 0x8000;
        state.renderScale = Math.min(1, state.renderScale + 0.05);
    } else if (state.kind === 'dorrie') {
        const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
        let homeDistance = Math.hypot(homeDx, homeDz);
        const angleToHome = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
        const circularTurn = 0x4000 - (Math.atan2(homeDistance - 2000, 2000) * 0x8000 / Math.PI);
        const signedDelta = ((state.yaw - angleToHome + 0x8000) & 0xFFFF) - 0x8000;
        const targetYaw = (angleToHome + (signedDelta < 0 ? -circularTurn : circularTurn)) & 0xFFFF;
        const targetYawVel = ((((targetYaw - state.yaw + 0x8000) & 0xFFFF) - 0x8000) / 50);
        state.verticalVel += Math.max(-5, Math.min(5, targetYawVel - state.verticalVel));
        state.yaw = (state.yaw + state.verticalVel) & 0xFFFF;
        state.forwardVel += Math.max(-0.5, Math.min(0.5, 5 - state.forwardVel));
        state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
        state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
        homeDistance = Math.hypot(state.home[0] - state.position[0], state.home[2] - state.position[2]);
        if (homeDistance < 1650 || homeDistance > 2300) {
            const clampedDistance = Math.max(1650, Math.min(2300, homeDistance));
            const scale = clampedDistance / homeDistance;
            state.position[0] = state.home[0] + (state.position[0] - state.home[0]) * scale;
            state.position[2] = state.home[2] + (state.position[2] - state.home[2]) * scale;
        }
        state.animationIndex = 1;
    } else if (state.kind === 'skeeter') {
        if (state.action === 0) {
            state.animationIndex = 1; state.animationSpeed = 1; state.forwardVel = 0;
            if (state.timer === 0) {
                state.walkTimer = 60 + Math.floor(30 * randomFloat(state));
                state.targetYaw = (state.yaw + (randomU16(state) % 0x4000) - 0x2000) & 0xFFFF;
            }
            state.yaw = approachBinang(state.yaw, state.targetYaw, 200);
            if (state.timer++ > state.walkTimer) {
                state.action = 1; state.timer = 0; state.forwardVel = 80;
            }
        } else {
            state.animationIndex = 0; state.animationSpeed = 1;
            state.forwardVel = Math.max(0, state.forwardVel - 0.8);
            if (state.forwardVel === 0) {
                state.action = 0; state.timer = 0;
                state.targetYaw = (state.yaw + (randomU16(state) & 1 ? 1 : -1) * (randomU16(state) % 0x2000)) & 0xFFFF;
            }
        }
        const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
        if (Math.hypot(homeDx, homeDz) > 1000)
            state.yaw = approachBinang(state.yaw, Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF, 0x400);
        state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
        state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
    } else if (state.kind === 'walkingPenguin') {
        const steps: [number, number, number, number][] = [
            [60, 0, 6, 1], [30, 3, 0, 1], [30, 0, 12, 2],
            [30, 3, 0, 1], [30, 0, -6, 1], [30, 3, 0, 1],
        ];
        let speed = 0;
        if (state.action === 0) {
            const step = steps[state.sequenceStep];
            state.animationIndex = step[1]; state.animationSpeed = step[3]; speed = step[2];
            if (++state.walkTimer >= step[0]) { state.walkTimer = 0; state.sequenceStep = (state.sequenceStep + 1) % steps.length; }
            if (state.position[0] < 300) { state.action = 1; state.timer = 0; }
        } else if (state.action === 1 || state.action === 3) {
            state.animationIndex = 0; state.animationSpeed = 1;
            state.yaw = (state.yaw + 0x400) & 0xFFFF;
            if (state.timer++ === 31) { state.action = state.action === 1 ? 2 : 0; state.timer = 0; }
        } else {
            state.animationIndex = 0; state.animationSpeed = 2; speed = 12;
            if (state.position[0] > 1700) { state.action = 3; state.timer = 0; }
        }
        state.position[0] += Math.sin(binang(state.yaw)) * speed;
        state.position[2] += Math.cos(binang(state.yaw)) * speed;
        state.visible = true;
    } else if (state.kind === 'toxBox') {
        // The three SSL boxes follow fixed ROM action tables. Directions are
        // followed by a landing action; -1 wraps to the start of the table.
        const forward = [4, 1], backward = [5, 1], right = [6, 1], left = [7, 1];
        const tables = [
            [...forward, ...forward, ...right, ...right, ...backward, ...backward, ...right, ...right, ...backward, 2,
                ...forward, ...forward, ...forward, 2,
                ...backward, ...backward, ...left, ...left, ...forward, ...forward, ...left, ...left, ...backward, ...backward, ...backward, 2,
                ...forward],
            [...forward, ...forward, ...left, ...left, ...left, 2,
                ...right, ...right, ...right, ...backward, ...backward, ...right, ...backward, ...backward, 2,
                ...forward, ...forward, ...left],
            [...forward, ...forward, ...forward, ...forward, ...forward, 2,
                ...backward, ...backward, ...backward, ...backward, ...backward, ...left, 2,
                ...right, ...right, ...backward, 2,
                ...forward, ...left],
        ];
        const table = tables[Math.min(state.parameter, 2)];
        const progressAction = (): void => {
            state.sequenceStep = (state.sequenceStep + 1) % table.length;
            state.action = table[state.sequenceStep];
            state.timer = -1;
        };
        if (state.action === 0) {
            state.sequenceStep = 0;
            state.action = table[0];
            state.position[1] = state.home[1] + 256;
            state.timer = -1;
        } else if (state.action >= 4) {
            state.position[1] = state.home[1] + 259 + 99.41124 * Math.sin((state.timer + 1) / 8 * Math.PI);
            let forwardVel = 0, upVel = 0, deltaPitch = 0, deltaRoll = 0;
            if (state.action === 4) { forwardVel = 64; deltaPitch = 0x800; }
            else if (state.action === 5) { forwardVel = -64; deltaPitch = -0x800; }
            else if (state.action === 6) { upVel = -64; deltaRoll = 0x800; }
            else { upVel = 64; deltaRoll = -0x800; }
            if ((((state.facePitch + 0x8000) & 0xFFFF) - 0x8000) < 0) deltaRoll = -deltaRoll;
            state.facePitch = (state.facePitch + deltaPitch) & 0xFFFF;
            state.faceRoll = (state.faceRoll + deltaRoll) & 0xFFFF;
            const yaw = binang(state.yaw);
            state.position[0] += Math.sin(yaw) * forwardVel + Math.cos(yaw) * upVel;
            state.position[2] += Math.cos(yaw) * forwardVel - Math.sin(yaw) * upVel;
            if (state.timer === 7) progressAction();
        } else {
            if (state.action === 1) state.position[1] = state.home[1] + 259;
            if (state.timer === 20) progressAction();
        }
        state.timer++;
    } else if (state.kind === 'pokey') {
        if (!state.visible) {
            state.visible = true;
            vec3.copy(state.position, state.home);
            state.moveYaw = state.homeYaw;
            state.yaw = state.homeYaw;
            state.walkTimer = 0;
        }
        {
            const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
            const homeDistance = Math.hypot(homeDx, homeDz);
            const angleToMario = Math.atan2(dxMario, dzMario) * 0x8000 / Math.PI & 0xFFFF;
            if (homeDistance > 1000) {
                state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
            } else if (marioDistance > 2000) {
                if (state.walkTimer-- <= 0) {
                    state.targetYaw = (state.moveYaw + (randomU16(state) & 1 ? 0x2000 : -0x2000)) & 0xFFFF;
                    state.walkTimer = 30 + Math.floor(50 * randomFloat(state));
                }
            } else {
                let targetOffset = Math.max(0, Math.min(0x4000, Math.floor(0x4000 - (marioDistance - 200) * 10)));
                const angleDelta = ((angleToMario - state.moveYaw + 0x8000) & 0xFFFF) - 0x8000;
                if (angleDelta > 0) targetOffset = -targetOffset;
                state.targetYaw = (angleToMario + targetOffset) & 0xFFFF;
            }
            state.moveYaw = approachBinang(state.moveYaw, state.targetYaw, 0x200);
            state.yaw = state.moveYaw;
            state.forwardVel = 5;
            state.position[0] += Math.sin(binang(state.moveYaw)) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.moveYaw)) * state.forwardVel;
        }
    } else if (state.kind === 'wiggler') {
        // At full health Wiggler wanders at 16 units/frame, choosing a
        // quarter-turn every 30..79 frames and returning inside 1200 of home.
        state.forwardVel += Math.max(-1, Math.min(1, 16 - state.forwardVel));
        const homeDx = state.home[0] - state.position[0], homeDz = state.home[2] - state.position[2];
        if (Math.hypot(homeDx, homeDz) > 1200) {
            state.targetYaw = Math.atan2(homeDx, homeDz) * 0x8000 / Math.PI & 0xFFFF;
        } else if (state.walkTimer-- <= 0) {
            state.targetYaw = (state.yaw + (randomU16(state) & 1 ? 0x4000 : -0x4000)) & 0xFFFF;
            state.walkTimer = 30 + Math.floor(50 * randomFloat(state));
        }
        state.yaw = approachBinang(state.yaw, state.targetYaw, Math.round(30 * state.forwardVel));
        state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
        state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
        state.animationIndex = 0;
        state.animationSpeed = 0.06 * state.forwardVel;
        state.trail.push(vec3.clone(state.position));
        if (state.trail.length > 32) state.trail.shift();
    } else if (state.kind === 'yoshi') {
        const homes = [[0, -5625], [-1364, -5912], [-1403, -4609], [-1004, -5308]];
        if (state.action === 0) {
            state.forwardVel = 0;
            state.animationIndex = 0;
            if (state.timer > 90) {
                const chosenHome = Math.floor(randomFloat(state) * 3.99);
                if (chosenHome !== state.sequenceStep) {
                    state.sequenceStep = chosenHome;
                    vec3.set(state.targetPosition, homes[chosenHome][0], state.home[1], homes[chosenHome][1]);
                    state.targetYaw = Math.atan2(state.targetPosition[0] - state.position[0], state.targetPosition[2] - state.position[2]) * 0x8000 / Math.PI & 0xFFFF;
                    state.action = 1;
                    state.timer = -1;
                }
            }
        } else {
            state.forwardVel = 10;
            state.position[0] += Math.sin(binang(state.yaw)) * state.forwardVel;
            state.position[2] += Math.cos(binang(state.yaw)) * state.forwardVel;
            state.yaw = approachBinang(state.yaw, state.targetYaw, 0x500);
            state.animationIndex = 1;
            if (vec3.distance(state.position, state.targetPosition) < 200) {
                state.action = 0;
                state.timer = -1;
            }
        }
        state.timer++;
    } else if (state.kind === 'bird') {
        const spawned = state.parameter === 0;
        // Spawned children enter flight when their parent spawner does; the
        // placed parent itself activates only inside Mario's 2000-unit radius.
        if (state.action === 0 && (spawned ? state.parent?.action === 1 : marioDistance < 2000)) {
            state.action = 1;
            state.visible = true;
            state.targetYaw = randomU16(state);
            state.verticalVel = 5000 - Math.floor(4000 * randomFloat(state));
            state.forwardVel = 40;
        }
        if (state.action === 1) {
            const targetX = spawned ? state.parent!.position[0] : -20;
            const targetY = spawned ? state.parent!.position[1] : 10000;
            const targetZ = spawned ? state.parent!.position[2] : -3990;
            const targetDx = targetX - state.position[0], targetDz = targetZ - state.position[2];
            const lateralDistance = Math.hypot(targetDx, targetDz);
            state.targetYaw = Math.atan2(targetDx, targetDz) * 0x8000 / Math.PI & 0xFFFF;
            // SM64's atan2s(y, x) angle convention is equivalent to the usual
            // atan2(x, y); a target above the bird therefore produces a
            // negative (upward) move pitch.
            const targetPitch = Math.atan2(state.position[1] - targetY, lateralDistance) * 0x8000 / Math.PI & 0xFFFF;
            state.yaw = approachBinang(state.yaw, state.targetYaw, 800);
            state.verticalVel = approachBinang(state.verticalVel, targetPitch, 140);
            if (spawned)
                state.forwardVel = 0.04 * vec3.distance(state.position, state.parent!.position) + 20;
            const yawError = ((state.targetYaw - state.yaw + 0x8000) & 0xFFFF) - 0x8000;
            const targetRoll = Math.max(-0x3000, Math.min(0x3000, -yawError * 2));
            state.faceRoll = approachBinang(state.faceRoll, targetRoll & 0xFFFF, 600);
            const pitch = binang(state.verticalVel), speed = state.forwardVel;
            state.position[0] += Math.cos(pitch) * Math.sin(binang(state.yaw)) * speed;
            state.position[1] -= Math.sin(pitch) * speed;
            state.position[2] += Math.cos(pitch) * Math.cos(binang(state.yaw)) * speed;
            if ((spawned ? state.parent!.position[1] : state.position[1]) > 8000) state.visible = false;
        }
    } else if (state.kind === 'thwomp') {
        // grindel_thwomp_act_*: raise 10/frame for 41 frames, add 5 on
        // transition, wait 10..39, accelerate downward by 4/frame, land for
        // 10 frames, then wait 20..29 at the bottom.
        if (state.action === 0) {
            if (state.timer > state.parameter + 40) { state.position[1] += 5; state.action = 1; state.timer = -1; }
            else state.position[1] += 10;
        } else if (state.action === 1) {
            if (state.timer === 0) state.walkTimer = 10 + Math.floor(30 * randomFloat(state));
            if (state.timer > state.walkTimer) { state.action = 2; state.timer = -1; state.verticalVel = 0; }
        } else if (state.action === 2) {
            state.verticalVel -= 4;
            state.position[1] += state.verticalVel;
            if (state.position[1] < state.home[1]) { state.position[1] = state.home[1]; state.verticalVel = 0; state.action = 3; state.timer = -1; }
        } else if (state.action === 3) {
            if (state.timer >= 10) { state.action = 4; state.timer = -1; }
        } else {
            if (state.timer === 0) state.walkTimer = 20 + Math.floor(10 * randomFloat(state));
            if (state.timer > state.walkTimer) { state.action = 0; state.timer = -1; }
        }
        state.timer++;
    }
    if (state.kind === 'goomba') updateCyclicBlink(state, 30, 50, 5);
    else if (state.kind === 'bobomb' || state.kind === 'bobombBuddy' || state.kind === 'yoshi') updateRandomBlink(state);
    else if (state.kind === 'koopa') updateCyclicBlink(state, 20, 50, 4);
    else if (state.kind === 'enemyLakitu') updateCyclicBlink(state, 20, 40, 4);
    else if (state.kind === 'pokey') updateCyclicBlink(state, 30, 60, 4);
    else if (state.kind === 'bowser') {
        // geo_switch_bowser_eyes: open for 51 callbacks, then pass through
        // half-closed, closed, and reset for four callbacks apiece.
        const limit = state.animState === 0 ? 50 : 2;
        if (state.blinkTimer > limit) {
            state.animState = state.animState === 0 ? 1 : state.animState === 1 ? 2 : state.animState === 2 ? 8 : 0;
            state.blinkTimer = 0;
        } else {
            state.blinkTimer++;
        }
    } else if (isPenguinKind(state.kind)) {
        // geo_switch_tuxie_mother_eyes uses the shared global timer for every
        // penguin: open for 43 frames, half-closed for two, closed for two,
        // then half-closed for the final three frames of the 50-frame cycle.
        const eyePhase = state.auxiliaryTimer % 50;
        state.animState = eyePhase < 43 ? 0 : eyePhase < 45 ? 1 : eyePhase < 47 ? 2 : 1;
        state.auxiliaryTimer++;
    }
    if (state.animationIndex !== state.previousAnimationIndex) {
        const previousAnimationIndex = state.previousAnimationIndex;
        state.previousAnimationIndex = state.animationIndex;
        // klepto_set_and_check_if_anim_at_end jumps from clip five back to
        // frame nine of clip zero, keeping the wing beat phase continuous.
        state.animationFrame = state.kind === 'klepto' && previousAnimationIndex === 5 && state.animationIndex === 0 ? 9 : 0;
    } else {
        state.animationFrame += state.animationSpeed;
    }
}

function applyIdleBehavior(base: mat4, state: IdleBehaviorState, wigglerBodyIndex?: number, pokeyPartIndex?: number, chainPartIndex?: number): mat4 {
    let position = state.position;
    let yaw = state.yaw;
    if (wigglerBodyIndex !== undefined && state.trail.length > 0) {
        const sampleIndex = Math.max(0, state.trail.length - 1 - wigglerBodyIndex * 9);
        position = state.trail[sampleIndex];
        const ahead = state.trail[Math.min(state.trail.length - 1, sampleIndex + 2)];
        const dx = ahead[0] - position[0], dz = ahead[2] - position[2];
        if (dx !== 0 || dz !== 0) yaw = Math.atan2(dx, dz) * 0x8000 / Math.PI & 0xFFFF;
    }
    if (pokeyPartIndex !== undefined) {
        const offsetAngle = pokeyPartIndex * 0x4000 + state.lastFrame * 0x800;
        position = vec3.fromValues(
            state.position[0] + Math.cos(binang(offsetAngle)) * 6,
            state.position[1] + 480 - pokeyPartIndex * 120,
            state.position[2] + Math.sin(binang(offsetAngle)) * 6,
        );
    }
    if (chainPartIndex !== undefined && chainPartIndex > 0) {
        const t = chainPartIndex / 5;
        position = vec3.lerp(vec3.create(), state.position, state.home, t);
        position[1] = Math.max(state.home[1], position[1] - Math.sin(Math.PI * t) * 120);
    }
    const transform = mat4.create();
    mat4.translate(transform, transform, position);
    mat4.rotateY(transform, transform, binang(yaw - state.homeYaw));
    mat4.rotateX(transform, transform, binang(state.facePitch));
    mat4.rotateZ(transform, transform, binang(state.faceRoll));
    mat4.scale(transform, transform, [state.renderScale, state.renderScale, state.renderScale]);
    mat4.translate(transform, transform, [-state.home[0], -state.home[1], -state.home[2]]);
    return mat4.mul(transform, transform, base);
}

// Frame zero of bobomb_seg8_anim_080237FC. Bob-ombs and Bob-omb Buddies share
// this skeleton and otherwise leave their animated joints at the geo-layout
// origin, separating the body, feet, eyes, and fuse.
const bobombInitialPose: GeoAnimationPose = {
    rootTranslation: [-8, 162, 0],
    rotations: [
        binang3(0, 16383, 0),
        binang3(518, 52, 31725),
        binang3(0, 0, 0),
        binang3(0, 0, 0),
        binang3(0, 0, 26917),
        binang3(0, 0, -22954),
        binang3(0, 0, 0),
        binang3(0, 0, 0),
        binang3(0, 0, 8456),
        binang3(0, 0, -14401),
        binang3(0, 0, 0),
        binang3(0, 0, 0),
        binang3(0, 0, 0),
    ],
};

function setGeoLayerRenderMode(state: MkRSPState, layer: number): void {
    if (layer === 4)
        state.gDPSetRenderMode(RENDER_MODES.G_RM_AA_ZB_TEX_EDGE, RENDER_MODES.G_RM_AA_ZB_TEX_EDGE2);
    else if (layer >= 5)
        state.gDPSetRenderMode(RENDER_MODES.G_RM_AA_ZB_XLU_SURF, RENDER_MODES.G_RM_AA_ZB_XLU_SURF2);
    else
        state.gDPSetRenderMode(RENDER_MODES.G_RM_AA_ZB_OPA_SURF, RENDER_MODES.G_RM_AA_ZB_OPA_SURF2);
}

function runDisplayList(state: MkRSPState, address: number): void {
    try {
        runDL_F3D(state, address);
    } catch (error) {
        throw new Error(`SM64 display list 0x${address.toString(16).padStart(8, '0')} failed`, { cause: error });
    }
}

class SM64Renderer implements Viewer.SceneGfx {
    public textureHolder = new FakeTextureHolder([]);
    private renderHelper: GfxRenderHelper;
    private renderInstList = new GfxRenderInstList();
    private models: BasicRspRenderer[] = [];
    private objectModels: { models: BasicRspRenderer[]; matrix: mat4; animated: boolean; usesAnimStateSwitch?: boolean; requiredAnimState?: number; snufitPart?: 'mask' | 'body'; textureFrameDivisor?: number; spinYRate?: number; motionPath?: number[][]; motionSpeed?: number; motionPathFrameStep?: number; spawnPeriod?: number; nearSpawnPeriod?: number; spawnDistanceMin?: number; spawnDistanceMax?: number; spawnOdds?: number; spawnRequiresMarioBelow?: boolean; motionRollRate?: number; animationMatrices?: mat4[]; animationLooping?: boolean; alternateAnimationMatrices?: Record<number, mat4[]>; alternateAnimationLooping?: Record<number, boolean>; animationPhase?: number; idleState?: IdleBehaviorState; wigglerBodyIndex?: number; pokeyPartIndex?: number; chainPartIndex?: number; billboardDepthOffset?: number }[] = [];
    private modelMatrix = mat4.create();
    private skybox: SkyboxRenderer | null = null;
    private collisionFloors: CollisionFloorIndex;
    private behaviorsInitialized = false;

    constructor(device: GfxDevice, segmentBuffers: ArrayBufferSlice[], displayLists: DisplayListInfo[], objects: ObjectInfo[], movtex: MovtexInfo[], modelGeos: Record<number, number>, extractedModelDLs: Record<number, number>, collisionData: ArrayBufferSlice | undefined, private initialCameraMatrix: mat4) {
        this.renderHelper = new GfxRenderHelper(device);
        this.collisionFloors = parseCollisionFloors(collisionData);
        if (segmentBuffers[0x0A] !== undefined)
            this.skybox = createSkyboxRenderer(device, this.renderHelper.renderCache, segmentBuffers[0x0A]);
        const state = new MkRSPState(segmentBuffers, true);
        state.initStateMk64();
        // SM64's level display lists inherit lighting from the global RSP setup and only
        // issue local clear/set commands for meshes that contain actual vertex colors.
        state.gSPSetGeometryMode(RSP_Geometry.G_LIGHTING);
        for (const dl of displayLists) {
            state.gSPTexture(false, 0, 0, 0, 0);
            setGeoLayerRenderMode(state, dl.layer);
            runDisplayList(state, dl.address);
            const output = state.finish();
            if (output !== null) {
                const model = new BasicRspRenderer(this.renderHelper.renderCache, output, false, 0);
                this.models.push(model);
            }
        }
        // GEO_ASM generates these meshes every frame in SM64. The extractor records
        // the ROM descriptors; a temporary vertex segment lets the normal F3D path
        // render them while their texture matrices retain the original 30 Hz motion.
        const movtexVertexData = new ArrayBuffer(movtex.reduce((size, surface) => size + surface.vertices.length * 0x10, 0));
        const movtexView = new DataView(movtexVertexData);
        let movtexOffset = 0;
        const sslQuicksandLightDirection = vec3.normalize(vec3.create(), vec3.fromValues(0x28, 0x28, 0x28));
        segmentBuffers[0x10] = new ArrayBufferSlice(movtexVertexData);
        // The game's generated movtex nodes keep their RSP state across meshes of
        // the same material family. Preserve that continuity (some SSL quicksand
        // begin lists deliberately inherit state), but keep water, sand, and lava
        // separate so their TMEM / other-mode setup cannot contaminate each other.
        const movtexStates = new Map<MovtexInfo['kind'], MkRSPState>();
        for (const surface of movtex) {
            let movtexState = movtexStates.get(surface.kind);
            if (movtexState === undefined) {
                movtexState = new MkRSPState(segmentBuffers, true);
                movtexState.initStateMk64();
                movtexStates.set(surface.kind, movtexState);
            }
            const vertexAddress = 0x10000000 | movtexOffset;
            for (const vertex of surface.vertices) {
                movtexView.setInt16(movtexOffset + 0x00, vertex[0]);
                movtexView.setInt16(movtexOffset + 0x02, vertex[1]);
                movtexView.setInt16(movtexOffset + 0x04, vertex[2]);
                movtexView.setInt16(movtexOffset + 0x08, vertex[3] * 1024);
                movtexView.setInt16(movtexOffset + 0x0A, vertex[4] * 1024);
                if (surface.lighting) {
                    // Colored movtex stores a signed normal here, not RGB. Bake
                    // the one-light SM64 result into vertex color: this keeps the
                    // generated mesh independent of the shared MK64 light state,
                    // whose MOVEMEM assumptions do not match every Fast3D list.
                    const normal = vec3.fromValues((vertex[5] << 24) >> 24, (vertex[6] << 24) >> 24, (vertex[7] << 24) >> 24);
                    vec3.normalize(normal, normal);
                    const intensity = 0x3F / 0xFF + Math.max(0, vec3.dot(normal, sslQuicksandLightDirection)) * (1 - 0x3F / 0xFF);
                    const shade = Math.round(intensity * 0xFF);
                    movtexView.setUint8(movtexOffset + 0x0C, shade);
                    movtexView.setUint8(movtexOffset + 0x0D, shade);
                    movtexView.setUint8(movtexOffset + 0x0E, shade);
                } else {
                    movtexView.setUint8(movtexOffset + 0x0C, vertex[5] ?? 0xFF);
                    movtexView.setUint8(movtexOffset + 0x0D, vertex[6] ?? 0xFF);
                    movtexView.setUint8(movtexOffset + 0x0E, vertex[7] ?? 0xFF);
                }
                movtexView.setUint8(movtexOffset + 0x0F, surface.alpha);
                movtexOffset += 0x10;
            }
            // MOV_TEX_ROT_TRIS and MOV_TEX_LIGHT_TRIS store signed normals in
            // the Vtx color bytes, while non-colored movtex stores literal RGBA.
            // Do not inherit this mode from the preceding level display list.
            movtexState.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
            setGeoLayerRenderMode(movtexState, surface.alpha < 0xFF ? 5 : 1);
            runDisplayList(movtexState, surface.materialAddress ?? 0x020175F0);
            // Material lists can install lights and geometry modes. Colored
            // movtex normals have already been converted to their lit shade
            // above, so the generated Vtx must be consumed as RGBA afterward.
            movtexState.gSPClearGeometryMode(RSP_Geometry.G_LIGHTING | RSP_Geometry.G_FOG);
            movtexState.gDPSetTextureImage(0, 2, 1, surface.textureAddress);
            movtexState.gDPSetTile(0, 2, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
            movtexState.gDPLoadBlock(7, 0, 0, 1023, 256);
            movtexState.gDPSetTile(0, 2, 8, 0, 0, 0, 0, 5, 0, 0, 5, 0);
            movtexState.gDPSetTileSize(0, 0, 0, 124, 124);
            movtexState.gSPVertex(vertexAddress, surface.vertices.length, 0);
            for (let i = 0; i + 2 < surface.indices.length; i += 3)
                movtexState.gSPTri(surface.indices[i], surface.indices[i + 1], surface.indices[i + 2]);
            runDisplayList(movtexState, 0x02017670);
            const output = movtexState.finish();
            if (output !== null) {
                const model = new BasicRspRenderer(this.renderHelper.renderCache, output, false, surface.alpha < 0xFF ? 1 : 0);
                // Generated movtex vertices use SM64's original Fast3D winding.
                // The shared MK64 renderer applies the opposite host-side cull
                // convention, which removes the upward-facing SSL sand fans.
                // These generated surfaces have no visible underside in-game, so
                // render them two-sided instead of rewriting the ROM triangle order.
                model.setBackfaceCullingEnabled(false);
                model.setTextureAnimation(surface.scrollS ?? 0, surface.rotation ?? 0);
                this.models.push(model);
            }
        }
        const modelDLs = new Map<number, number[]>([
            [0x17, [0x0302FEE8]],
            [0x18, [0x03030FA0]], [0x19, [0x03032088]],
            [0x1A, [0x03032170]], [0x1B, [0x03033258]],
            [0x74, [0x03007800, 0x03007800, 0x03007828, 0x03007828, 0x03007850, 0x03007850, 0x03007878, 0x03007878]],
            [0x75, [0x03007800, 0x03007800, 0x03007828, 0x03007828, 0x03007850, 0x03007850, 0x03007878, 0x03007878]],
            [0xD7, [0x03007940, 0x03007940, 0x03007968, 0x03007968, 0x03007990, 0x03007990, 0x030079B8, 0x030079B8]],
            [0xD8, [0x03007940, 0x03007940, 0x03007968, 0x03007968, 0x03007990, 0x03007990, 0x030079B8, 0x030079B8]],
            [0x7A, [0x0302B870, 0x0302BA18]],
            [0x7C, [0x0302DA48, 0x0302DD08]],
        ]);
        for (const [model, dl] of Object.entries(extractedModelDLs)) modelDLs.set(Number(model), [dl]);
        const renderObjects = [...objects];
        for (const object of objects) {
            if (object.behavior === 0x13004898) {
                for (let bodyIndex = 1; bodyIndex <= 3; bodyIndex++)
                    renderObjects.push({ ...object, model: 0x58, behavior: undefined, wigglerBodyIndex: bodyIndex });
            }
        }
        const wigglerStates = new Map<string, IdleBehaviorState>();
        const pokeyStates = new Map<string, IdleBehaviorState>();
        const chainChompStates = new Map<string, IdleBehaviorState>();
        const birdStates = new Map<string, IdleBehaviorState>();
        for (const object of renderObjects) {
            const matrix = mat4.create();
            const idleKind = behaviorKind(object.behavior);
            const wigglerKey = object.position.join(',');
            let idleState = object.wigglerBodyIndex !== undefined ? wigglerStates.get(wigglerKey)
                : object.pokeyPartIndex !== undefined && object.pokeyPartIndex !== 0 ? pokeyStates.get(wigglerKey)
                : object.chainPartIndex !== undefined && object.chainPartIndex !== 0 ? chainChompStates.get(wigglerKey)
                : idleKind === undefined ? undefined : makeIdleBehaviorState(object, idleKind);
            if (idleState?.kind === 'wiggler' && object.wigglerBodyIndex === undefined) wigglerStates.set(wigglerKey, idleState);
            if (idleState?.kind === 'pokey' && object.pokeyPartIndex === 0) pokeyStates.set(wigglerKey, idleState);
            if (idleState?.kind === 'chainChomp' && object.chainPartIndex === 0) chainChompStates.set(wigglerKey, idleState);
            if (idleState?.kind === 'bird') {
                if (object.birdParent === undefined)
                    birdStates.set(object.position.join(','), idleState);
                else
                    idleState.parent = birdStates.get(object.birdParent.join(','));
            }
            const animated = object.model === 0x74 || object.model === 0x75 || object.model === 0xD7 || object.model === 0xD8;
            const billboard = object.billboard ?? object.behavior === 0x13000C84;
            const rx = object.rotation[0] * Math.PI / 180, ry = object.rotation[1] * Math.PI / 180, rz = object.rotation[2] * Math.PI / 180;
            const initialYOffset = object.graphYOffset ?? (object.behavior === 0x13003354 || object.behavior === 0x13003388 ? 40
                : object.behavior === 0x130026D4 || object.behavior === 0x13002710 ? 60
                : object.behavior === 0x130027E4 || object.behavior === 0x13002804 ? 30
                : object.behavior === 0x1300506C ? 21
                : object.behavior === 0x1300518C ? 40
                : object.behavior === 0x130033BC ? 5
                : object.behavior === 0x13000B58 || object.behavior === 0x13000B8C || object.behavior === 0x13000BC8 ? 1 : 0);
            const spinYRate = object.model === 0x7A ? 0x800 : object.model === 0x78 ? 400 : undefined;
            mat4.fromTranslation(matrix, [object.position[0], object.position[1] + initialYOffset, object.position[2]]);
            mat4.rotateY(matrix, matrix, ry); mat4.rotateX(matrix, matrix, rx); mat4.rotateZ(matrix, matrix, rz);
            // Goomba needs no model-space axis correction. Its ROM vertices
            // are Y-up and its animation root supplies the intended facing
            // rotation; adding another root rotation breaks the feet hierarchy.
            if (object.scaleXYZ !== undefined) mat4.scale(matrix, matrix, [object.scaleXYZ[0], object.scaleXYZ[1], object.scaleXYZ[2]]);
            else if (object.scale !== undefined) mat4.scale(matrix, matrix, [object.scale, object.scale, object.scale]);
            else if (object.behavior === 0x13005354 || object.behavior === 0x1300565C || object.behavior === 0x13005680) mat4.scale(matrix, matrix, [0.7, 0.7, 0.7]);
            else if (object.behavior === 0x130026D4 || object.behavior === 0x13002710) mat4.scale(matrix, matrix, [2, 2, 2]);
            else if (object.behavior === 0x13002768 || object.behavior === 0x13002790) mat4.scale(matrix, matrix, [3, 3, 3]);
            else if (object.behavior === 0x13000B8C || object.behavior === 0x13000BC8) mat4.scale(matrix, matrix, [1.4, 1.4, 1.4]);
            else if (object.behavior === 0x13002E58) mat4.scale(matrix, matrix, [6, 6, 6]);
            else if (object.behavior === 0x130046DC) mat4.scale(matrix, matrix, [1.5, 1.5, 1.5]);
            else if (object.behavior === 0x1300506C) mat4.scale(matrix, matrix, [0.7, 0.7, 0.7]);
            else if (object.behavior === 0x130055DC) mat4.scale(matrix, matrix, [0.5, 0.5, 0.5]);
            else if (object.behavior === 0x13004898) mat4.scale(matrix, matrix, [4, 4, 4]);
            else if (object.wigglerBodyIndex !== undefined) mat4.scale(matrix, matrix, [4, 4, 4]);
            else if (object.behavior === 0x13001548) mat4.scale(matrix, matrix, [2, 2, 2]);
            else if (object.behavior === 0x1300525C) mat4.scale(matrix, matrix, [0.9, 0.9, 0.9]);
            else if (object.behavior === 0x13000528) mat4.scale(matrix, matrix, [2, 2, 2]);
            else if (object.behavior === 0x13005440) mat4.scale(matrix, matrix, [1, 1.5, 1]);
            else if (object.behavior === 0x13000C84) mat4.scale(matrix, matrix, [7, 7, 7]);
            else if (object.behavior === 0x13004F40) mat4.scale(matrix, matrix, [3, 3, 3]);
            else if (object.behavior === 0x13002BB8) mat4.scale(matrix, matrix, [2, 2, 2]);
            else if (object.behavior === 0x13002088) mat4.scale(matrix, matrix, [4, 4, 4]);
            else if (object.behavior === 0x13004580 && object.behaviorParameter === 4) mat4.scale(matrix, matrix, [0.8, 0.8, 0.8]);
            const geoAddress = modelGeos[object.model];
            if (geoAddress !== undefined && segmentBuffers[geoAddress >>> 24] !== undefined) {
                if (object.behavior === 0x13000C84) {
                    // bhvFlame uses geo_switch_anim_state with eight ROM display
                    // lists and advances oAnimState once every two frames.
                    const frameParts = Array.from({ length: 8 }, (_, frame) => parseGeoLayout(segmentBuffers, geoAddress, undefined, frame));
                    for (let partIndex = 0; partIndex < frameParts[0].length; partIndex++) {
                        const models: BasicRspRenderer[] = [];
                        for (const parts of frameParts) {
                            const part = parts[partIndex];
                            if (part === undefined) continue;
                            state.gSPTexture(false, 0, 0, 0, 0);
                            setGeoLayerRenderMode(state, part.layer);
                            runDisplayList(state, part.displayList);
                            const output = state.finish();
                            if (output !== null) models.push(new BasicRspRenderer(this.renderHelper.renderCache, output, true, part.layer >= 5 ? 1 : 0));
                        }
                        if (models.length > 0) {
                            const partMatrix = mat4.mul(mat4.create(), matrix, frameParts[0][partIndex].matrix);
                            this.objectModels.push({ models, matrix: partMatrix, animated: true, textureFrameDivisor: 2 });
                        }
                    }
                    continue;
                }
                const isBobomb = object.model === 0xBC || object.model === 0xC3;
                const animationInfo: [number, number] | undefined = object.wigglerBodyIndex !== undefined ? [0x0500C874, 0] : behaviorAnimation(object.behavior, object.model);
                const animation = animationInfo === undefined ? null : decodeAnimationTable(segmentBuffers, animationInfo[0], animationInfo[1]);
                const initialPose = animation?.poses[0] ?? (isBobomb ? bobombInitialPose : undefined);
                if (idleState?.kind === 'homingAmp') {
                    // The four Amp electricity switches add parts in state one,
                    // rather than replacing parts one-for-one. Build both
                    // complete layouts and gate them as structural variants;
                    // indexing one layout with the other would attach joints
                    // and display lists to the wrong transforms.
                    for (let switchState = 0; switchState < 2; switchState++) {
                        const stateParts = parseGeoLayout(segmentBuffers, geoAddress, initialPose, switchState);
                        const stateAnimationParts = animation?.poses.map((pose) => parseGeoLayout(segmentBuffers, geoAddress, pose, switchState));
                        for (let partIndex = 0; partIndex < stateParts.length; partIndex++) {
                            const part = stateParts[partIndex];
                            state.gSPTexture(false, 0, 0, 0, 0);
                            setGeoLayerRenderMode(state, part.layer);
                            runDisplayList(state, part.displayList);
                            const output = state.finish();
                            if (output === null) continue;
                            const localMatrix = part.billboard ? withoutInheritedScale(part.matrix) : part.matrix;
                            const partMatrix = mat4.mul(mat4.create(), matrix, localMatrix);
                            const animationMatrices = stateAnimationParts?.map((frameParts) => {
                                const framePart = frameParts[partIndex];
                                const local = framePart.billboard ? withoutInheritedScale(framePart.matrix) : framePart.matrix;
                                return mat4.mul(mat4.create(), matrix, local);
                            });
                            this.objectModels.push({
                                models: [new BasicRspRenderer(this.renderHelper.renderCache, output, billboard || part.billboard, part.layer >= 5 ? 1 : 0)],
                                matrix: partMatrix, animated: false, requiredAnimState: switchState,
                                animationMatrices, animationLooping: animation?.looping,
                                animationPhase: Math.abs(Math.floor(object.position[0] + object.position[2])), idleState,
                            });
                        }
                    }
                    continue;
                }
                const fixedSwitchState = idleState !== undefined && (idleState.kind === 'eyerokHand' || idleState.kind === 'klepto' || idleState.kind === 'unagi' || idleState.kind === 'circlingAmp')
                    ? idleState.animState : 0;
                const parts = parseGeoLayout(segmentBuffers, geoAddress, initialPose, fixedSwitchState);
                const usesAnimStateSwitch = idleState !== undefined && (idleState.kind === 'goomba' || idleState.kind === 'bobomb' || idleState.kind === 'bobombBuddy'
                    || idleState.kind === 'bowser' || idleState.kind === 'koopa' || idleState.kind === 'enemyLakitu' || idleState.kind === 'pokey' || idleState.kind === 'yoshi'
                    || idleState.kind === 'smallPenguin' || idleState.kind === 'walkingPenguin' || idleState.kind === 'tuxiesMother');
                const switchStateParts = idleState?.kind === 'bowser'
                    ? Array.from({ length: 9 }, (_, eyeState) => parseGeoLayout(segmentBuffers, geoAddress, initialPose, eyeState, 0x802B7C64))
                    : idleState !== undefined && (idleState.kind === 'smallPenguin' || idleState.kind === 'walkingPenguin' || idleState.kind === 'tuxiesMother')
                    ? Array.from({ length: 3 }, (_, eyeState) => parseGeoLayout(segmentBuffers, geoAddress, initialPose, eyeState, 0x802BFBAC))
                    : usesAnimStateSwitch ? [parts, parseGeoLayout(segmentBuffers, geoAddress, initialPose, 1)] : [parts];
                const animationParts = animation?.poses.map((pose) => parseGeoLayout(segmentBuffers, geoAddress, pose, fixedSwitchState));
                const alternateAnimationParts: Record<number, ReturnType<typeof parseGeoLayout>[]> = {};
                const alternateAnimationLooping: Record<number, boolean> = {};
                const alternateAnimationIndices = object.behavior === 0x13002E58 || object.behavior === 0x130020E8 ? [3]
                    : object.behavior === 0x13005468 ? [0]
                    : object.behavior === 0x13001548 ? [2]
                    : object.behavior === 0x13005310 ? [5, 6]
                    : object.behavior === 0x13004538 ? [1]
                    : object.behavior === 0x13004918 ? [1]
                    : object.behavior === 0x13000F08 || object.behavior === 0x13001CB0 ? [4, 5, 10]
                    : object.behavior === 0x13004580 ? [7, 10, 11] : [];
                if (animationInfo !== undefined) {
                    for (const index of alternateAnimationIndices) {
                        const alternateAnimation = decodeAnimationTable(segmentBuffers, animationInfo[0], index);
                        if (alternateAnimation !== null) {
                            alternateAnimationParts[index] = alternateAnimation.poses.map((pose) => parseGeoLayout(segmentBuffers, geoAddress, pose, fixedSwitchState));
                            alternateAnimationLooping[index] = alternateAnimation.looping;
                        }
                    }
                }
                for (let partIndex = 0; partIndex < parts.length; partIndex++) {
                    const part = parts[partIndex];
                    state.gSPTexture(false, 0, 0, 0, 0);
                    setGeoLayerRenderMode(state, part.layer);
                    runDisplayList(state, part.displayList);
                    const output = state.finish();
                    if (output === null) continue;
                    let partLocalMatrix = part.matrix;
                    if (part.billboard) {
                        // SM64's mtxf_billboard() discards inherited graph-node scale,
                        // while retaining the inherited translation. Object scale is
                        // subsequently applied by geo_process_billboard().
                        partLocalMatrix = withoutInheritedScale(part.matrix);
                    }
                    const partMatrix = mat4.mul(mat4.create(), matrix, partLocalMatrix);
                    const animationMatrices = animationParts?.map((frameParts) => {
                        const framePart = frameParts[partIndex];
                        const local = framePart.billboard ? withoutInheritedScale(framePart.matrix) : framePart.matrix;
                        return mat4.mul(mat4.create(), matrix, local);
                    });
                    const alternateAnimationMatrices: Record<number, mat4[]> = {};
                    for (const [index, frames] of Object.entries(alternateAnimationParts)) {
                        alternateAnimationMatrices[Number(index)] = frames.map((frameParts) => {
                            const framePart = frameParts[partIndex];
                            const local = framePart.billboard ? withoutInheritedScale(framePart.matrix) : framePart.matrix;
                            return mat4.mul(mat4.create(), matrix, local);
                        });
                    }
                    const models = [new BasicRspRenderer(this.renderHelper.renderCache, output, billboard || part.billboard, part.layer >= 5 ? 1 : 0, object.model === 0x7A && part.displayList === 0x0302B870)];
                    const hasDifferentSwitchDisplayList = switchStateParts.some((stateParts) => stateParts[partIndex]?.displayList !== part.displayList);
                    if (hasDifferentSwitchDisplayList) {
                        for (let switchState = 1; switchState < switchStateParts.length; switchState++) {
                            const switchedPart = switchStateParts[switchState][partIndex];
                            if (switchedPart === undefined) continue;
                            state.gSPTexture(false, 0, 0, 0, 0);
                            setGeoLayerRenderMode(state, switchedPart.layer);
                            runDisplayList(state, switchedPart.displayList);
                            const switchedOutput = state.finish();
                            if (switchedOutput !== null)
                                models.push(new BasicRspRenderer(this.renderHelper.renderCache, switchedOutput, billboard || switchedPart.billboard, switchedPart.layer >= 5 ? 1 : 0));
                        }
                    }
                    const animationPhase = object.wigglerBodyIndex !== undefined ? 23 * object.wigglerBodyIndex % 26
                        : idleState?.kind === 'wiggler' ? 0 : Math.abs(Math.floor(object.position[0] + object.position[2]));
                    const snufitPart = idleState?.kind !== 'snufit' ? undefined
                        : part.displayList === 0x06009748 ? 'mask'
                        : part.displayList === 0x06009A10 ? 'body' : undefined;
                    this.objectModels.push({ models, matrix: partMatrix, animated: false, usesAnimStateSwitch, snufitPart, spinYRate, motionPath: object.motionPath, motionSpeed: object.motionSpeed, motionPathFrameStep: object.motionPathFrameStep, spawnPeriod: object.spawnPeriod, nearSpawnPeriod: object.nearSpawnPeriod, spawnDistanceMin: object.spawnDistanceMin, spawnDistanceMax: object.spawnDistanceMax, spawnOdds: object.spawnOdds, spawnRequiresMarioBelow: object.spawnRequiresMarioBelow, motionRollRate: object.motionRollRate, animationMatrices, animationLooping: animation?.looping, alternateAnimationMatrices, alternateAnimationLooping, animationPhase, idleState, wigglerBodyIndex: object.wigglerBodyIndex, pokeyPartIndex: object.pokeyPartIndex, chainPartIndex: object.chainPartIndex, billboardDepthOffset: object.billboardDepthOffset });
                }
                continue;
            }
            const lists = modelDLs.get(object.model);
            if (lists === undefined) continue;
            const models: BasicRspRenderer[] = [];
            for (const dl of lists) {
                state.gSPTexture(false, 0, 0, 0, 0);
                const alphaLayer = animated || (object.model >= 0x17 && object.model <= 0x1B) || dl === 0x0302BA18;
                setGeoLayerRenderMode(state, alphaLayer ? 4 : 1);
                runDisplayList(state, dl);
                const output = state.finish();
                if (output !== null)
                    models.push(new BasicRspRenderer(this.renderHelper.renderCache, output, billboard, 0, dl === 0x0302B870));
            }
            if (animated) {
                if (models.length > 0) this.objectModels.push({ models, matrix, animated: true, spinYRate, motionPath: object.motionPath, motionSpeed: object.motionSpeed, motionPathFrameStep: object.motionPathFrameStep, spawnPeriod: object.spawnPeriod, nearSpawnPeriod: object.nearSpawnPeriod, spawnDistanceMin: object.spawnDistanceMin, spawnDistanceMax: object.spawnDistanceMax, spawnOdds: object.spawnOdds, spawnRequiresMarioBelow: object.spawnRequiresMarioBelow, motionRollRate: object.motionRollRate, idleState, pokeyPartIndex: object.pokeyPartIndex, chainPartIndex: object.chainPartIndex, billboardDepthOffset: object.billboardDepthOffset });
            } else {
                for (const model of models) this.objectModels.push({ models: [model], matrix, animated: false, spinYRate, motionPath: object.motionPath, motionSpeed: object.motionSpeed, motionPathFrameStep: object.motionPathFrameStep, spawnPeriod: object.spawnPeriod, nearSpawnPeriod: object.nearSpawnPeriod, spawnDistanceMin: object.spawnDistanceMin, spawnDistanceMax: object.spawnDistanceMax, spawnOdds: object.spawnOdds, spawnRequiresMarioBelow: object.spawnRequiresMarioBelow, motionRollRate: object.motionRollRate, idleState, pokeyPartIndex: object.pokeyPartIndex, chainPartIndex: object.chainPartIndex, billboardDepthOffset: object.billboardDepthOffset });
            }
        }
        // SM64 is already Y-up and uses the same handedness expected by this renderer.
        mat4.identity(this.modelMatrix);
    }

    public adjustCameraController(c: CameraController): void { c.setSceneMoveSpeedMult(2); }
    public getDefaultWorldMatrix(dst: mat4): void { mat4.copy(dst, this.initialCameraMatrix); }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput) {
        const manager = this.renderHelper.renderInstManager;
        manager.setCurrentList(this.renderInstList);
        const template = this.renderHelper.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);
        let offs = template.allocateUniformBuffer(F3DEX_Program.ub_SceneParams, 16);
        const mappedF32 = template.mapUniformBufferF32(F3DEX_Program.ub_SceneParams);
        offs += fillMatrix4x4(mappedF32, offs, viewerInput.camera.projectionMatrix);
        this.skybox?.prepareToRender(manager, viewerInput);
        for (const model of this.models)
            model.prepareToRender(manager, viewerInput, this.modelMatrix);
        const gameFrame = Math.floor(viewerInput.time * 30 / 1000);
        const marioPosition = vec3.fromValues(viewerInput.camera.worldMatrix[12], viewerInput.camera.worldMatrix[13], viewerInput.camera.worldMatrix[14]);
        const uniqueStates: IdleBehaviorState[] = [];
        const stateSet = new Set<IdleBehaviorState>();
        for (const object of this.objectModels) {
            if (object.idleState !== undefined && !stateSet.has(object.idleState)) {
                stateSet.add(object.idleState);
                uniqueStates.push(object.idleState);
            }
        }
        // Viewer time is global and does not restart when a scene is loaded. Do
        // not replay every behavior tick since viewer startup on the first render.
        if (!this.behaviorsInitialized) {
            for (const state of uniqueStates) state.lastFrame = gameFrame - 1;
            this.behaviorsInitialized = true;
        } else if (uniqueStates.some((state) => gameFrame < state.lastFrame)) {
            for (const state of uniqueStates) state.lastFrame = gameFrame - 1;
        }
        if (uniqueStates.length > 0) {
            const firstFrame = Math.min(...uniqueStates.map((state) => state.lastFrame)) + 1;
            for (let frame = firstFrame; frame <= gameFrame; frame++) {
                // Constructor order places linked parents before their children.
                // Step every state once at this frame before advancing again.
                for (const state of uniqueStates) {
                    if (state.lastFrame < frame) {
                        stepIdleBehavior(state, marioPosition, this.collisionFloors);
                        state.lastFrame = frame;
                    }
                }
            }
        }
        for (const object of this.objectModels) {
            if (object.idleState !== undefined && !object.idleState.visible) continue;
            if (object.requiredAnimState !== undefined && object.idleState?.animState !== object.requiredAnimState) continue;
            const frame = object.usesAnimStateSwitch && object.idleState !== undefined
                ? object.idleState.animState % object.models.length
                : object.animated ? Math.floor(gameFrame / (object.textureFrameDivisor ?? 1)) % object.models.length : 0;
            let matrix = object.matrix;
            let animationMatrices = object.animationMatrices;
            let animationLooping = object.animationLooping ?? true;
            if (object.idleState !== undefined) {
                animationMatrices = object.alternateAnimationMatrices?.[object.idleState.animationIndex] ?? animationMatrices;
                animationLooping = object.alternateAnimationLooping?.[object.idleState.animationIndex] ?? animationLooping;
            }
            if (animationMatrices !== undefined) {
                const rawAnimationFrame = object.idleState !== undefined ? Math.floor(object.idleState.animationFrame + (object.animationPhase ?? 0))
                    : Math.floor(gameFrame + (object.animationPhase ?? 0));
                const animationFrame = animationLooping
                    ? (rawAnimationFrame % animationMatrices.length + animationMatrices.length) % animationMatrices.length
                    : Math.max(0, Math.min(rawAnimationFrame, animationMatrices.length - 1));
                matrix = animationMatrices[animationFrame];
            }
            if (object.spinYRate !== undefined) {
                // Object behaviors express yaw velocity in binang per 30 Hz game frame.
                matrix = mat4.rotateY(mat4.create(), matrix, viewerInput.time * 30 / 1000 * binang(object.spinYRate));
            }
            if (object.idleState !== undefined) matrix = applyIdleBehavior(matrix, object.idleState, object.wigglerBodyIndex, object.pokeyPartIndex, object.chainPartIndex);
            if (object.snufitPart === 'mask')
                matrix = mat4.translate(mat4.create(), matrix, [0, -32, 180]);
            else if (object.snufitPart === 'body')
                matrix = mat4.scale(mat4.create(), matrix, [0.666, 0.666, 0.666]);
            if (object.billboardDepthOffset !== undefined) {
                matrix = mat4.clone(matrix);
                vec3.set(billboardOffsetScratch, marioPosition[0] - matrix[12], marioPosition[1] - matrix[13], marioPosition[2] - matrix[14]);
                if (vec3.squaredLength(billboardOffsetScratch) > 0) vec3.normalize(billboardOffsetScratch, billboardOffsetScratch);
                matrix[12] += billboardOffsetScratch[0] * object.billboardDepthOffset;
                matrix[13] += billboardOffsetScratch[1] * object.billboardDepthOffset;
                matrix[14] += billboardOffsetScratch[2] * object.billboardDepthOffset;
            }
            if (object.motionPath !== undefined && object.motionPath.length > 1 && object.motionSpeed !== undefined && object.spawnPeriod !== undefined) {
                const spawnDX = marioPosition[0] - object.motionPath[0][0];
                const spawnDY = marioPosition[1] - object.motionPath[0][1];
                const spawnDZ = marioPosition[2] - object.motionPath[0][2];
                const spawnDistance = Math.hypot(spawnDX, spawnDY, spawnDZ);
                if (object.spawnDistanceMin !== undefined && spawnDistance < object.spawnDistanceMin)
                    continue;
                if (object.spawnDistanceMax !== undefined && spawnDistance >= object.spawnDistanceMax)
                    continue;
                if (object.spawnRequiresMarioBelow && marioPosition[1] > object.motionPath[0][1])
                    continue;
                const spawnPeriod = object.nearSpawnPeriod !== undefined && spawnDistance < 6000 ? object.nearSpawnPeriod : object.spawnPeriod;
                const duration = object.motionPathFrameStep !== undefined
                    ? (object.motionPath.length - 1) * object.motionPathFrameStep
                    : pathLength(object.motionPath) / object.motionSpeed;
                const firstAge = gameFrame % spawnPeriod;
                for (let age = firstAge, eventOffset = 0; age < duration; age += spawnPeriod, eventOffset++) {
                    if (object.spawnOdds !== undefined && object.spawnOdds > 1) {
                        // The original spawners consume the global SM64 RNG at
                        // each eligible period. Use a stable event hash here so
                        // scrubbing time cannot change whether a particular
                        // spawn happened, while retaining the ROM's 1/N odds.
                        const eventIndex = Math.floor(gameFrame / spawnPeriod) - eventOffset;
                        const pathSeed = Math.floor(object.motionPath[0][0] * 13 + object.motionPath[0][1] * 7 + object.motionPath[0][2] * 17);
                        let hash = Math.imul(eventIndex ^ pathSeed, 0x45D9F3B);
                        hash = Math.imul(hash ^ (hash >>> 16), 0x45D9F3B);
                        hash ^= hash >>> 16;
                        const random = (hash >>> 0) / 0x100000000;
                        if (Math.floor(random * object.spawnOdds) !== 0) continue;
                    }
                    const position = object.motionPathFrameStep !== undefined
                        ? sampleFramePath(object.motionPath, age, object.motionPathFrameStep)
                        : samplePath(object.motionPath, age * object.motionSpeed);
                    const movingMatrix = mat4.clone(matrix);
                    movingMatrix[12] += position[0] - object.motionPath[0][0];
                    movingMatrix[13] += position[1] - object.motionPath[0][1];
                    movingMatrix[14] += position[2] - object.motionPath[0][2];
                    if (object.motionRollRate !== undefined)
                        mat4.rotateX(movingMatrix, movingMatrix, binang(age * object.motionRollRate));
                    object.models[frame].prepareToRender(manager, viewerInput, movingMatrix);
                }
            } else {
                object.models[frame].prepareToRender(manager, viewerInput, matrix);
            }
        }
        manager.popTemplate();
        this.renderHelper.prepareToRender();

        const builder = this.renderHelper.renderGraph.newGraphBuilder();
        const mainColorDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.Color0, viewerInput, standardFullClearRenderPassDescriptor);
        const mainDepthDesc = makeBackbufferDescSimple(GfxrAttachmentSlot.DepthStencil, viewerInput, standardFullClearRenderPassDescriptor);
        const mainColorTargetID = builder.createRenderTargetID(mainColorDesc, 'Main Color');
        const mainDepthTargetID = builder.createRenderTargetID(mainDepthDesc, 'Main Depth');
        builder.pushPass((pass) => {
            pass.setDebugName('Main');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, mainColorTargetID);
            pass.attachRenderTargetID(GfxrAttachmentSlot.DepthStencil, mainDepthTargetID);
            pass.exec((passRenderer) => this.renderInstList.drawOnPassRenderer(this.renderHelper.renderCache, passRenderer));
        });
        this.renderHelper.antialiasingSupport.pushPasses(builder, viewerInput, mainColorTargetID);
        builder.resolveRenderTargetToExternalTexture(mainColorTargetID, viewerInput.onscreenTexture);
        builder.execute();
        this.renderInstList.reset();
    }

    public destroy(device: GfxDevice): void {
        this.skybox?.destroy(device);
        for (const model of this.models) model.destroy(device);
        for (const object of this.objectModels)
            for (const model of object.models) model.destroy(device);
        this.renderHelper.destroy();
    }
}

class SceneDesc implements Viewer.SceneDesc {
    constructor(public id: string, public name: string) {}
    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        const manifestData = await context.dataFetcher.fetchData(`${pathBase}/manifest.json`);
        const manifest = JSON.parse(new TextDecoder().decode(manifestData.createTypedArray(Uint8Array))) as LevelInfo[];
        const info = manifest.find((entry) => entry.id === this.id)!;
        const compressedArchive = await context.dataFetcher.fetchData(`${pathBase}/${this.id}.crg1`);
        const archiveData = ArrayBufferSlice.fromView(decompress(compressedArchive.createTypedArray(Uint8Array)));
        const archive = BYML.parse<LevelArchive>(archiveData, BYML.FileType.CRG1);
        const segmentBuffers: ArrayBufferSlice[] = [];
        for (const segment of archive.Segments)
            segmentBuffers[segment.ID] = segment.Data;
        return new SM64Renderer(device, segmentBuffers, info.displayLists, info.objects ?? [], info.movtex ?? [], info.modelGeos ?? {}, info.modelDLs ?? {}, archive.Collision, makeInitialCameraMatrix(info.id, info.marioStart, info.cameraMode));
    }
}

const levelNames: [string, string][] = [
    ['castle_grounds', 'Castle Grounds'], ['castle_inside', "Peach's Castle"],
    ['castle_courtyard', 'Castle Courtyard'],
    ['bob', 'Bob-omb Battlefield'], ['wf', "Whomp's Fortress"], ['jrb', 'Jolly Roger Bay'],
    ['ccm', 'Cool, Cool Mountain'], ['bbh', "Big Boo's Haunt"], ['hmc', 'Hazy Maze Cave'],
    ['lll', 'Lethal Lava Land'], ['ssl', 'Shifting Sand Land'], ['ddd', 'Dire, Dire Docks'],
    ['sl', "Snowman's Land"], ['wdw', 'Wet-Dry World'], ['ttm', 'Tall, Tall Mountain'],
    ['thi', 'Tiny-Huge Island'], ['ttc', 'Tick Tock Clock'], ['rr', 'Rainbow Ride'],
    ['bitdw', 'Bowser in the Dark World'],
    ['bitfs', 'Bowser in the Fire Sea'], ['bits', 'Bowser in the Sky'],
    ['vcutm', 'Vanish Cap Under the Moat'], ['cotmc', 'Cavern of the Metal Cap'],
    ['totwc', 'Tower of the Wing Cap'], ['pss', "The Princess's Secret Slide"],
    ['sa', 'The Secret Aquarium'], ['wmotr', 'Wing Mario Over the Rainbow'],
    ['bowser_1', 'Bowser 1 Arena'], ['bowser_2', 'Bowser 2 Arena'], ['bowser_3', 'Bowser 3 Arena'],
    ['ending', 'Ending'],
];
const sceneDescs = levelNames.map(([id, name]) => new SceneDesc(id, name));

export const sceneGroup: Viewer.SceneGroup = {
    id: 'sm64', name: 'Super Mario 64', altName: 'sm64', sceneDescs,
};
