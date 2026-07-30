import { quat, vec3 } from 'gl-matrix';
import { MPHCollisionData, queryCollisionSphereContacts } from './mph_collision.js';

export const ENTITY_TYPE_ENEMY_SPAWN = 6;

const ENEMY_SPAWN_DATA_SIZE = 0x200;
const FX32_SCALE = 1 / 0x1000;

export interface MPHEnemySpawnEntry {
    nodeName: string;
    layerMask: number;
    dataOffset: number;
    dataLength: number;
    type: number;
    entityId: number;
}

export interface MPHEnemySpawnEntity extends MPHEnemySpawnEntry {
    position: vec3;
    up: vec3;
    facing: vec3;
    enemyType: number;
    variant: number;
    hoverCenter: vec3 | null;
    hoverBobAngleStep: number;
    hoverBobRadius: number;
    surfaceCrawlerInitialFacing: vec3 | null;
    surfaceCrawlerTurnAngleStep: number;
    surfaceCrawlerTurnLimit: number;
    mochtroid03Endpoint: vec3 | null;
    mochtroid03TravelTicks: number;
    mochtroidRoamingHorizontalRadius: number;
    mochtroidRoamingVerticalRange: number;
    patrolMode: number;
    patrolSpeed: number;
    patrolPoints: vec3[];
    guardBotRoamingCenter: vec3 | null;
    guardBotRoamingRadius: number;
    guardBotConfigId: number;
    alimbicTurretConfigId: number;
}

export class MPHGameplayRandom {
    private seed = 0;

    // GenerateGameplayRandomRange @ 0x020434D0
    public nextRange(limit: number): number {
        this.seed = (Math.imul(this.seed, 0x7FF8A3ED) + 0x2AA01D31) >>> 0;
        return Math.floor(limit * (this.seed >>> 16) / 0x10000);
    }
}

export interface MPHEnemyModelSpec {
    modelFilename: string;
    animationFilename?: string;
    sharedTextureFilename?: string;
    animationId?: number;
    additionalAnimationIds?: number[];
    additionalMaterialAnimationIds?: number[];
    texCoordAnimationId?: number;
    animationLoop?: boolean;
    localYawRadians?: number;
    attachmentNodeName?: string;
}

export interface MPHEnemyPreviewState {
    id: number;
    durationTicks: number;
    animationIndex: number;
}

export interface MPHEnemyPreviewStateSample {
    state: MPHEnemyPreviewState;
    timeInStateTicks: number;
    cycle: number;
}

export function sampleEnemyPreviewStateMachine(timeInMilliseconds: number, tickRate: number, states: readonly MPHEnemyPreviewState[]): MPHEnemyPreviewStateSample {
    if (states.length === 0)
        throw new Error('Enemy preview state machine requires at least one state');
    const cycleDuration = states.reduce((duration, state) => duration + state.durationTicks, 0);
    const totalTicks = Math.max(0, timeInMilliseconds * tickRate / 1000);
    const cycle = cycleDuration > 0 ? Math.floor(totalTicks / cycleDuration) : 0;
    let timeInCycle = cycleDuration > 0 ? totalTicks - cycle * cycleDuration : 0;
    for (const state of states) {
        if (timeInCycle < state.durationTicks)
            return { state, timeInStateTicks: timeInCycle, cycle };
        timeInCycle -= state.durationTicks;
    }
    return { state: states[states.length - 1], timeInStateTicks: 0, cycle };
}

function hashEnemyPreviewCycle(seed: number, cycle: number): number {
    let value = (seed ^ Math.imul(cycle + 1, 0x9E3779B1)) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x7FEB352D) >>> 0;
    value ^= value >>> 15;
    value = Math.imul(value, 0x846CA68B) >>> 0;
    return (value ^ (value >>> 16)) >>> 0;
}

function sampleOccasionalEnemyStateMachine(timeInMilliseconds: number, tickRate: number, seed: number,
        idleState: MPHEnemyPreviewState, minIdleTicks: number, maxIdleTicks: number,
        activeStates: readonly MPHEnemyPreviewState[]): MPHEnemyPreviewStateSample {
    let remainingTicks = Math.max(0, timeInMilliseconds * tickRate / 1000);
    const activeDuration = activeStates.reduce((duration, state) => duration + state.durationTicks, 0);
    const idleRange = Math.max(0, maxIdleTicks - minIdleTicks);
    let cycle = 0;
    while (true) {
        const idleDuration = minIdleTicks + (hashEnemyPreviewCycle(seed, cycle) % (idleRange + 1));
        const cycleDuration = idleDuration + activeDuration;
        if (remainingTicks < cycleDuration) {
            if (remainingTicks < idleDuration)
                return { state: { ...idleState, durationTicks: idleDuration }, timeInStateTicks: remainingTicks, cycle };
            remainingTicks -= idleDuration;
            for (const state of activeStates) {
                if (remainingTicks < state.durationTicks)
                    return { state, timeInStateTicks: remainingTicks, cycle };
                remainingTicks -= state.durationTicks;
            }
        }
        remainingTicks -= cycleDuration;
        cycle++;
    }
}

function readFx32(view: DataView, offs: number): number {
    return view.getInt32(offs, true) * FX32_SCALE;
}

function readVec3Fx(view: DataView, offs: number): vec3 {
    return vec3.fromValues(readFx32(view, offs + 0x00), readFx32(view, offs + 0x04), readFx32(view, offs + 0x08));
}

function transformEnemyLocalOffset(dst: vec3, offset: vec3, position: vec3, facing: vec3, up: vec3): void {
    const z = vec3.normalize(vec3.create(), facing);
    const x = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), up, z));
    const y = vec3.cross(vec3.create(), z, x);
    vec3.scaleAndAdd(dst, position, x, offset[0]);
    vec3.scaleAndAdd(dst, dst, y, offset[1]);
    vec3.scaleAndAdd(dst, dst, z, offset[2]);
}

export function parseEnemySpawn(entry: MPHEnemySpawnEntry, view: DataView, random = new MPHGameplayRandom()): MPHEnemySpawnEntity {
    if (entry.dataLength !== ENEMY_SPAWN_DATA_SIZE)
        throw new Error(`Invalid EnemySpawn record size ${entry.dataLength}`);
    const offs = entry.dataOffset;
    const position = readVec3Fx(view, offs + 0x04);
    const up = readVec3Fx(view, offs + 0x10);
    const facing = readVec3Fx(view, offs + 0x1C);
    const enemyType = view.getUint16(offs + 0x28, true);
    let hoverCenter: vec3 | null = null;
    let hoverBobAngleStep = 0;
    let hoverBobRadius = 0;
    let surfaceCrawlerInitialFacing: vec3 | null = null;
    let surfaceCrawlerTurnAngleStep = 0;
    let surfaceCrawlerTurnLimit = 0;
    let mochtroid03Endpoint: vec3 | null = null;
    let mochtroid03TravelTicks = 0;
    let mochtroidRoamingHorizontalRadius = 0;
    let mochtroidRoamingVerticalRange = 0;
    let patrolMode = 0;
    let patrolSpeed = 0;
    let patrolPointOffset = 0;
    let patrolPointCount = 0;
    const patrolPoints: vec3[] = [];
    let guardBotRoamingCenter: vec3 | null = null;
    let guardBotRoamingRadius = 0;
    let guardBotConfigId = 0;

    if (enemyType === 0x02) {
        // InitializeTemroid @ 0x02162758 transforms the local +0x94 offset,
        // raises it by 0x800, and constructs a rectangular patrol from the
        // local +0x88 direction and the +0xA8/+0xA0 side lengths.
        hoverCenter = vec3.create();
        transformEnemyLocalOffset(hoverCenter, readVec3Fx(view, offs + 0x94), position, facing, up);
        hoverCenter[1] += 0x800 * FX32_SCALE;
        vec3.copy(facing, readVec3Fx(view, offs + 0x88));
        facing[1] = 0;
        vec3.normalize(facing, facing);
        const forwardOffset = readFx32(view, offs + 0xA8);
        const lateralOffset = readFx32(view, offs + 0xA0);
        const forward = vec3.scale(vec3.create(), facing, forwardOffset);
        const lateral = vec3.fromValues(-facing[2] * lateralOffset, 0, facing[0] * lateralOffset);
        patrolPoints.push(
            vec3.clone(hoverCenter),
            vec3.add(vec3.create(), hoverCenter, forward),
            vec3.add(vec3.create(), vec3.add(vec3.create(), hoverCenter, forward), lateral),
            vec3.add(vec3.create(), hoverCenter, lateral),
        );
        patrolSpeed = 0x199 * FX32_SCALE * 30;
    } else if (enemyType === 0x01 || enemyType === 0x0C) {
        // InitializeZoomer @ 0x02161DE4; InitializeGeemer @ 0x02154710
        surfaceCrawlerInitialFacing = vec3.fromValues(
            random.nextRange(0x1000) * FX32_SCALE, 0,
            random.nextRange(0x1000) * FX32_SCALE);
        if (vec3.squaredLength(surfaceCrawlerInitialFacing) === 0)
            vec3.copy(surfaceCrawlerInitialFacing, facing);
        vec3.normalize(surfaceCrawlerInitialFacing, surfaceCrawlerInitialFacing);
        const turnRange = enemyType === 0x01 ? 0x3000 : 0x7000;
        surfaceCrawlerTurnAngleStep = (random.nextRange(turnRange) + 0x3000) * FX32_SCALE;
        surfaceCrawlerTurnLimit = enemyType === 0x01 ? 40 : 60;
        random.nextRange(0);
    } else if (enemyType === 0x03) {
        // InitializeMochtroidVariant3 @ 0x021642F8
        hoverCenter = readVec3Fx(view, offs + 0x94);
        vec3.add(hoverCenter, hoverCenter, position);
        hoverCenter[1] += 0x1555 * FX32_SCALE;
        const travelDirection = readVec3Fx(view, offs + 0x88);
        travelDirection[1] = 0;
        vec3.normalize(travelDirection, travelDirection);
        const forwardOffset = readFx32(view, offs + 0xA8);
        const lateralOffset = readFx32(view, offs + 0xA0);
        mochtroid03Endpoint = vec3.fromValues(
            hoverCenter[0] + travelDirection[0] * forwardOffset - travelDirection[2] * lateralOffset,
            hoverCenter[1],
            hoverCenter[2] + travelDirection[2] * forwardOffset + travelDirection[0] * lateralOffset);
        // ApplyMochtroidType03State derives its state-1 timer from +0xA8,
        // not from the full two-axis endpoint displacement.
        mochtroid03TravelTicks = Math.abs(forwardOffset) / (0x11E * FX32_SCALE);
        hoverBobRadius = (random.nextRange(0x1800) + 0x0800) * 0.5 * FX32_SCALE;
        hoverBobAngleStep = (random.nextRange(0x6000) + 0x1000) * FX32_SCALE;
    } else if (enemyType === 0x04) {
        // InitializeMochtroidType04 @ 0x02164C04
        hoverCenter = readVec3Fx(view, offs + 0x7C);
        vec3.add(hoverCenter, hoverCenter, position);
        hoverCenter[1] += 0x1555 * FX32_SCALE;
        hoverBobAngleStep = (random.nextRange(0x6000) + 0x1000) * FX32_SCALE;
        hoverBobRadius = (random.nextRange(0x1AAB) + 0x0555) * 0.5 * FX32_SCALE;
        mochtroidRoamingHorizontalRadius = readFx32(view, offs + 0x88);
    } else if (enemyType === 0x05) {
        // InitializeMochtroidType05 @ 0x02165540
        hoverCenter = readVec3Fx(view, offs + 0x7C);
        vec3.add(hoverCenter, hoverCenter, position);
        hoverCenter[1] += 0x1555 * FX32_SCALE;
        hoverBobRadius = (random.nextRange(0x1AAB) + 0x0555) * 0.5 * FX32_SCALE;
        hoverBobAngleStep = (random.nextRange(0x3000) + 0x1000) * FX32_SCALE;
        mochtroidRoamingHorizontalRadius = readFx32(view, offs + 0x88);
        mochtroidRoamingVerticalRange = readFx32(view, offs + 0x8C);
    } else if (enemyType === 0x06) {
        // InitializeMochtroidType06 @ 0x02165F58
        hoverCenter = vec3.create();
        transformEnemyLocalOffset(hoverCenter, readVec3Fx(view, offs + 0x7C), position, facing, up);
        hoverCenter[1] += 0x1555 * FX32_SCALE;
        vec3.copy(facing, readVec3Fx(view, offs + 0x1C));
        vec3.normalize(facing, facing);
        mochtroidRoamingHorizontalRadius = readFx32(view, offs + 0x88);
        mochtroidRoamingVerticalRange = readFx32(view, offs + 0x8C);
        hoverBobRadius = (random.nextRange(0x1AAB) + 0x0555) * 0.5 * FX32_SCALE;
        hoverBobAngleStep = (random.nextRange(0x3000) + 0x1000) * FX32_SCALE;
    } else if (enemyType === 0x00) {
        // InitializeWarWasp @ 0x0215FB28
        patrolMode = view.getUint8(offs + 0x1B0);
        patrolPointCount = Math.min(view.getUint32(offs + 0x1AC, true), 16);
        patrolPointOffset = offs + 0xEC;
        patrolSpeed = 0x333 * FX32_SCALE * 15;
    } else if (enemyType === 0x0A) {
        // InitializeBarbedWarWasp @ 0x02151A9C
        const difficulty = Math.min(view.getUint32(offs + 0x2C, true), 2);
        patrolMode = view.getUint8(offs + 0x1B8);
        patrolPointCount = Math.min(view.getUint32(offs + 0x1B4, true), 16);
        patrolPointOffset = offs + 0xF4;
        patrolSpeed = [0x400, 0x599, 0x266][difficulty] * FX32_SCALE * 15;
    } else if (enemyType === 0x23 || enemyType === 0x24) {
        // InitializeGuardBot1 @ 0x021567F0 transforms the second authored
        // volume record, then CalculateGuardBot1RoamingTarget @ 0x02157754
        // uses its center and radius.
        // InitializeGuardBot2 @ 0x02155338 and
        // CalculateGuardBot2RoamingTarget @ 0x0215651C use the preceding
        // volume slot but otherwise share the same representation.
        const volumeOffset = enemyType === 0x23 ? 0x7C : 0x84;
        guardBotRoamingCenter = vec3.create();
        transformEnemyLocalOffset(guardBotRoamingCenter, readVec3Fx(view, offs + volumeOffset), position, facing, up);
        guardBotRoamingRadius = readFx32(view, offs + volumeOffset + 0x0C);
        guardBotConfigId = enemyType === 0x24 ? view.getUint32(offs + 0x2C, true) : 0;
    }

    if (patrolMode >= 2) {
        for (let i = 0; i < patrolPointCount; i++) {
            const point = readVec3Fx(view, patrolPointOffset + i * 0x0C);
            vec3.add(point, point, position);
            patrolPoints.push(point);
        }
    }

    return {
        ...entry,
        position,
        up,
        facing,
        enemyType,
        variant: view.getUint32(offs + 0x30, true),
        hoverCenter,
        hoverBobAngleStep,
        hoverBobRadius,
        surfaceCrawlerInitialFacing,
        surfaceCrawlerTurnAngleStep,
        surfaceCrawlerTurnLimit,
        mochtroid03Endpoint,
        mochtroid03TravelTicks,
        mochtroidRoamingHorizontalRadius,
        mochtroidRoamingVerticalRange,
        patrolMode,
        patrolSpeed,
        patrolPoints,
        guardBotRoamingCenter,
        guardBotRoamingRadius,
        guardBotConfigId,
        alimbicTurretConfigId: enemyType === 0x12 ? Math.min(view.getUint32(offs + 0x2C, true), 2) : 0,
    };
}

// LoadEnemyTypeResources @ 0x02051D60
// Model table @ 0x020C8FC8; animation table @ 0x020C9648.
const enemyModels: readonly (MPHEnemyModelSpec | null)[] = [
    // InitializeWarWasp @ 0x0215FB28 binds animation 1 for state 0.
    { modelFilename: 'warwasp_lod0_Model.bin', animationFilename: 'warWasp_Anim.bin', animationId: 1, additionalAnimationIds: [3] },
    { modelFilename: 'zoomer_Model.bin', animationFilename: 'zoomer_Anim.bin', animationId: 0 },
    { modelFilename: 'Temroid_lod0_Model.bin' },
    // ApplyMochtroidType03State @ 0x02164968 cycles 3 (dormant),
    // 0 (travel), and 4 (recovery).
    { modelFilename: 'Chomtroid_Model.bin', animationFilename: 'Mochtroid_Anim.bin', animationId: 3, additionalAnimationIds: [0, 4] },
    // ApplyMochtroidType04State @ 0x0216545C selects animation 5 for state 0.
    { modelFilename: 'Chomtroid_Model.bin', animationFilename: 'Mochtroid_Anim.bin', animationId: 5, additionalAnimationIds: [0], texCoordAnimationId: 2 },
    // ApplyMochtroidType05State @ 0x02165D90 selects animation 6 for state 0.
    { modelFilename: 'Chomtroid_Model.bin', animationFilename: 'Mochtroid_Anim.bin', animationId: 6, additionalAnimationIds: [0] },
    // ApplyMochtroidType06State @ 0x021669F8 uses animation 7 for its
    // ten-tick materialization state, then animation 0 for roaming state 1.
    { modelFilename: 'Chomtroid_Model.bin', animationFilename: 'Mochtroid_Anim.bin', animationId: 0, additionalAnimationIds: [7] },
    null, null, null,
    // InitializeBarbedWarWasp @ 0x02151A9C binds animation 1 for state 0.
    { modelFilename: 'BarbedWarWasp_mdl_Model.bin', animationFilename: 'warWasp_Anim.bin', sharedTextureFilename: 'BarbedWarWasp_img_00_Model.bin', animationId: 1, additionalAnimationIds: [0, 2] },
    // InitializeShriekbat @ 0x021534CC selects animation 4 for state 0.
    // WakeShriekbatOnPlayerProximity @ 0x02153AFC and the subsequent state
    // callbacks select animations 0, 2, 3, and 1.
    { modelFilename: 'shriekbat_Model.bin', animationFilename: 'shriekbat_Anim.bin', animationId: 4, additionalAnimationIds: [0, 2, 3, 1] },
    // InitializeGeemer @ 0x02154710 selects animation 2 for its crawling state.
    // UpdateGeemer @ 0x02153B48 also uses animations 1/3 while a player is
    // nearby and animation 0 while returning to the passive crawl.
    { modelFilename: 'geemer_Model.bin', animationFilename: 'Geemer_Anim.bin', animationId: 2, additionalAnimationIds: [1, 3, 0] },
    null, null, null,
    // InitializeBlastcap @ 0x02154A1C selects idle animation 2;
    // CheckBlastcapPlayerProximity @ 0x02155030 selects attack animation 1.
    { modelFilename: 'blastcap_Model.bin', animationFilename: 'blastcap_Anim.bin', animationId: 2, additionalAnimationIds: [1] },
    null,
    { modelFilename: 'Alimbic_Turret_mdl_Model.bin', animationFilename: 'AlimbicTurret_Anim.bin', sharedTextureFilename: 'Alimbic_Turret_img_00_Model.bin', animationId: 0 },
    // InitializeCylinderBoss @ 0x0213361C selects animation 2 for the main
    // model. Its three encounter phases also use animations 4, 3, 0, and 1.
    { modelFilename: 'CylinderBoss_Model.bin', animationFilename: 'CylinderBoss_Anim.bin', animationId: 2, additionalAnimationIds: [4, 3, 0, 1], additionalMaterialAnimationIds: [0] },
    { modelFilename: 'CylinderBossEye_Model.bin', animationFilename: 'CylinderBossEye_Anim.bin', animationId: 0 },
    null, null,
    // InitializePsychoBit @ 0x0214F42C binds animation 3 for dormant state 9;
    // ApplyPsychoBitStateTransition @ 0x0215044C binds animation 0 on attack.
    { modelFilename: 'PsychoBit_mdl_Model.bin', animationFilename: 'PsychoBit_Anim.bin', sharedTextureFilename: 'PsychoBit_img_00_Model.bin', animationId: 3, additionalAnimationIds: [0] },
    // InitializeGorea1A @ 0x02133A18 binds node animation 17 and the
    // independent material animation 26.
    { modelFilename: 'Gorea1A_lod0_Model.bin', animationFilename: 'Gorea1A_Anim.bin', animationId: 17, additionalAnimationIds: [13], additionalMaterialAnimationIds: [26] },
    null, null, null,
    // InitializeGorea1BComponent @ 0x02137F3C binds node animation 3.
    { modelFilename: 'Gorea1B_lod0_Model.bin', animationFilename: 'Gorea1B_Anim.bin', animationId: 3 },
    null,
    // InitializePowerBombEnemy @ 0x0213BF0C loads the subtype-0x1E model
    // resource but never binds an animation. These are damageable projectile
    // entities, not looping ambient PowerBomb effects.
    { modelFilename: 'PowerBomb_Model.bin' },
    // InitializeGorea2 @ 0x0213D764 binds idle animation 7.
    { modelFilename: 'Gorea2_lod0_Model.bin', animationFilename: 'Gorea2_Anim.bin', animationId: 7, additionalAnimationIds: [10] },
    null,
    { modelFilename: 'goreaMeteor_Model.bin' },
    { modelFilename: 'PsychoBit_mdl_Model.bin', animationFilename: 'PsychoBit_Anim.bin', sharedTextureFilename: 'PsychoBit_img_00_Model.bin', animationId: 3 },
    // InitializeGuardBot2 @ 0x02155338 selects animation 4;
    // CheckGuardBot2PlayerDetected @ 0x02155CE8 selects animation 1 and
    // BeginGuardBot2ChargeAttack @ 0x02155BA8 selects animation 0.
    { modelFilename: 'GuardBot2_lod0_Model.bin', animationFilename: 'GuardBot02_Anim.bin', animationId: 4, additionalAnimationIds: [1, 0] },
    // InitializeGuardBot1 @ 0x021567F0 selects animation 5;
    // ProcessGuardBot1FireState @ 0x02156CB0 selects animation 0.
    { modelFilename: 'GuardBot1_mdl_Model.bin', animationFilename: 'GuardBot01_Anim.bin', sharedTextureFilename: 'GuardBot1_img_00_Model.bin', animationId: 5, additionalAnimationIds: [0] },
    // InitializeDripStank @ 0x0214E630 binds node animation 4 and texcoord animation 6.
    { modelFilename: 'DripStank_lod0_Model.bin', animationFilename: 'DripStank_Anim.bin', animationId: 4, additionalAnimationIds: [10, 11, 12, 9, 3], texCoordAnimationId: 6 },
    // InitializeAlimbicStatueEnemy @ 0x0215D388 selects animation 1 for
    // dormant state 0. Its active graph also uses 0, 7, 2, 6, 4, 3, and 5.
    { modelFilename: 'AlimbicStatue_lod0_Model.bin', animationFilename: 'AlimbicStatue_Anim.bin', animationId: 1, additionalAnimationIds: [0, 7, 2, 6, 4, 3, 5] },
    // InitializeLavaDemon @ 0x0215E8FC leaves dormant state 0 on animation
    // 3. The active sequence alternates 1/0, then retreats with animation 2.
    { modelFilename: 'LavaDemon_mdl_Model.bin', animationFilename: 'LavaDemon_Anim.bin', sharedTextureFilename: 'LavaDemon_img_00_Model.bin', animationId: 3, additionalAnimationIds: [1, 0, 2] },
    null,
    // ApplyBigEyeBossState @ 0x02135D74 selects animation 8 for the initial
    // open/idle state, animation 13 while activating, and animation 10 while
    // closing to fire.
    { modelFilename: 'BigEyeBall_Model.bin', animationFilename: 'BigEyeBall_Anim.bin', animationId: 8, additionalAnimationIds: [13, 10] },
    null,
    { modelFilename: 'BigEyeNest_Model.bin', animationFilename: 'BigEyeNest_Anim.bin', animationId: 0 },
    null,
    // InitializeBigEyeTurret @ 0x02136FBC binds texcoord animation 0 and
    // leaves it on frame 0 until the parent boss sends activation message 0x30.
    { modelFilename: 'BigEyeTurret_Model.bin', animationFilename: 'BigEyeTurret_Anim.bin', animationId: 0, animationLoop: false },
    // InitializeSphinkTickType2E @ 0x02157EA0 binds node animation 5 and texcoord animation 15.
    { modelFilename: 'SphinkTick_lod0_Model.bin', animationFilename: 'SphinkTick_Anim.bin', animationId: 5, additionalAnimationIds: [6, 12], texCoordAnimationId: 15 },
    // InitializeSphinkTickType2F @ 0x0215A970 binds node animation 5 and texcoord animation 15.
    { modelFilename: 'SphinkTick_lod0_Model.bin', animationFilename: 'SphinkTick_Anim.bin', animationId: 5, additionalAnimationIds: [6, 12], texCoordAnimationId: 15 },
    // CreateEnemyInstance @ 0x020503C0 has no subtype constructor for 0x30.
    null, null, null, null,
] as const;

const bigEyeSynapseModels: readonly MPHEnemyModelSpec[] = [
    0,
    2 * Math.PI / 3,
    -2 * Math.PI / 3,
].map((localYawRadians) => ({
    modelFilename: 'BigEyeSynapse_01_Model.bin',
    animationFilename: 'BigEyeSynapse_Anim.bin',
    animationId: 0,
    localYawRadians,
}));

const cylinderBossEyeModels: readonly MPHEnemyModelSpec[] = Array.from({ length: 12 }, (_, i) => ({
    modelFilename: 'CylinderBossEye_Model.bin',
    animationFilename: 'CylinderBossEye_Anim.bin',
    animationId: 0,
    additionalMaterialAnimationIds: [3, 5],
    attachmentNodeName: `torret_bone_${i + 2}`,
}));

const plantEnemyModels: Readonly<Record<number, MPHEnemyModelSpec>> = {
    // InitializeCarnivorousPlantComponent @ 0x021671D0 binds animation 0;
    // UpdateCarnivorousPlantComponent @ 0x021671B4 only applies contact damage.
    37: { modelFilename: 'PlantCarnivarous_Branched_Model.bin', animationFilename: 'PlantCarnivarous_Branched_Anim.bin', animationId: 0 },
    38: { modelFilename: 'PlantCarnivarous_Pod_Model.bin', animationFilename: 'PlantCarnivarous_Pod_Anim.bin', animationId: 0 },
    39: { modelFilename: 'PlantCarnivarous_PodLeaves_Model.bin', animationFilename: 'PlantCarnivarous_PodLeaves_Anim.bin', animationId: 0 },
    40: { modelFilename: 'PlantCarnivarous_Vine_Model.bin', animationFilename: 'PlantCarnivarous_Vine_Anim.bin', animationId: 0 },
};

export function getEnemyModelSpecs(enemy: MPHEnemySpawnEntity): readonly MPHEnemyModelSpec[] {
    // LoadRoomEnemyResources @ 0x020510C0
    if (enemy.enemyType === 0x33) {
        const spec = plantEnemyModels[enemy.variant];
        return spec !== undefined ? [spec] : [];
    }

    const spec = enemyModels[enemy.enemyType] ?? null;
    if (spec === null)
        return [];

    if (enemy.enemyType === 0x13)
        // InitializeCylinderBoss @ 0x0213361C creates twelve subtype-0x14
        // components. CreateCylinderBossTurretComponents @ 0x02133B48
        // attaches them to torret_bone_2 through torret_bone_13.
        return [spec, ...cylinderBossEyeModels];
    if (enemy.enemyType === 0x18)
        return [spec, enemyModels[0x1C]!];
    if (enemy.enemyType === 0x1F)
        // SpawnGoreaMeteor @ 0x0213FE84 creates subtype 0x21 dynamically
        // during Gorea2's projectile state; it is not a permanent child at
        // the boss origin.
        return [spec];
    if (enemy.enemyType === 0x29)
        // InitializeBigEyeBoss @ 0x021354BC creates three subtype-0x2C
        // children. CalculateBigEyeSynapseOrientation @ 0x02133798 places
        // them at 0 and +/-120 degrees about the boss up axis. The subtype-
        // 0x2A controller and the two auxiliary model instances owned by the
        // boss have no render callbacks.
        return [spec, ...bigEyeSynapseModels];
    return [spec];
}

function smoothstep(min: number, max: number, value: number): number {
    const t = Math.max(0, Math.min(1, (value - min) / (max - min)));
    return t * t * (3 - 2 * t);
}

export function getEnemyAnimationPhaseMilliseconds(enemy: MPHEnemySpawnEntity): number {
    return ((enemy.entityId * 1103 + enemy.enemyType * 3571) & 0xFFFF) * 1000 / 30;
}

export function isWaspEnemy(enemy: MPHEnemySpawnEntity): boolean {
    return enemy.enemyType === 0x00 || enemy.enemyType === 0x0A;
}

function sampleMochtroidType04Hover(dstPosition: vec3, dstFacing: vec3, enemy: MPHEnemySpawnEntity, timeInMilliseconds: number): boolean {
    if (enemy.hoverCenter === null)
        return false;

    // CalculateMochtroidType04HoverVelocity @ 0x02164EE8. During the
    // 30-tick state-0 reveal, animation frame 0..29 expands the orbit radius
    // and accelerates its angular step from one to roughly 1.5 degrees.
    // State 1 continues at 1.5 degrees per enemy tick.
    const ticks = Math.max(0, timeInMilliseconds * 15 / 1000);
    const completedRevealTicks = Math.min(Math.floor(ticks), 30);
    let orbitAngleDegrees = 0;
    for (let tick = 0; tick < completedRevealTicks; tick++)
        orbitAngleDegrees += 1 + Math.min(tick * 2, 29) / 60;
    if (ticks < 30)
        orbitAngleDegrees += (ticks - completedRevealTicks) *
            (1 + Math.min(completedRevealTicks * 2, 29) / 60);
    else
        orbitAngleDegrees += (ticks - 30) * 1.5;

    const revealFrame = Math.min(ticks * 2, 29);
    const radiusScale = ticks < 30 ? revealFrame / 30 : 1;
    const orbitAngle = orbitAngleDegrees * Math.PI / 180;
    const bobAngle = ticks * enemy.hoverBobAngleStep * Math.PI / 180;
    vec3.set(dstPosition,
        enemy.hoverCenter[0] + Math.sin(orbitAngle) * enemy.mochtroidRoamingHorizontalRadius * radiusScale,
        enemy.hoverCenter[1] + Math.sin(bobAngle) * enemy.hoverBobRadius,
        enemy.hoverCenter[2] + Math.cos(orbitAngle) * enemy.mochtroidRoamingHorizontalRadius * radiusScale);
    vec3.set(dstFacing, Math.cos(orbitAngle), 0, -Math.sin(orbitAngle));
    return true;
}

const mochtroidType03DwellTicks = 20;

function sampleMochtroidType03State(timeInMilliseconds: number, enemy: MPHEnemySpawnEntity): MPHEnemyPreviewStateSample {
    return sampleEnemyPreviewStateMachine(timeInMilliseconds, 15, [
        { id: 0, durationTicks: mochtroidType03DwellTicks, animationIndex: 0 },
        { id: 1, durationTicks: enemy.mochtroid03TravelTicks, animationIndex: 1 },
        { id: 2, durationTicks: mochtroidType03DwellTicks, animationIndex: 2 },
    ]);
}

function sampleMochtroidType03Patrol(dstPosition: vec3, dstFacing: vec3, enemy: MPHEnemySpawnEntity, timeInMilliseconds: number): boolean {
    if (enemy.hoverCenter === null || enemy.mochtroid03Endpoint === null)
        return false;

    // ProcessMochtroidType03DormantState @ 0x021645A4;
    // ProcessMochtroidType03ActiveState @ 0x021645D4
    const sample = sampleMochtroidType03State(timeInMilliseconds, enemy);
    const from = (sample.cycle & 1) === 0 ? enemy.hoverCenter : enemy.mochtroid03Endpoint;
    const to = (sample.cycle & 1) === 0 ? enemy.mochtroid03Endpoint : enemy.hoverCenter;

    if (sample.state.id === 0)
        vec3.copy(dstPosition, from);
    else if (sample.state.id === 1) {
        vec3.lerp(dstPosition, from, to, enemy.mochtroid03TravelTicks > 0 ?
            sample.timeInStateTicks / enemy.mochtroid03TravelTicks : 1);
        const bobAngle = sample.timeInStateTicks * enemy.hoverBobAngleStep * Math.PI / 180;
        dstPosition[1] += Math.sin(bobAngle) * enemy.hoverBobRadius;
    } else
        vec3.copy(dstPosition, to);

    vec3.sub(dstFacing, to, from);
    if (vec3.squaredLength(dstFacing) !== 0)
        vec3.normalize(dstFacing, dstFacing);
    return true;
}

export function sampleMochtroidType03Animation(timeInMilliseconds: number, enemy: MPHEnemySpawnEntity): { index: number, state: number, timeInState: number } {
    const sample = sampleMochtroidType03State(timeInMilliseconds, enemy);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 15,
    };
}

export function sampleBlastcapAnimation(timeInMilliseconds: number, seed = 0): { index: number, state: number, timeInState: number } {
    // The original transition into state 1 depends on player proximity. The
    // passive viewer substitutes a deterministic interval, then preserves the
    // original attack and recovery animation lengths.
    const sample = sampleOccasionalEnemyStateMachine(timeInMilliseconds, 30, seed,
        { id: 0, durationTicks: 0, animationIndex: 0 }, 120, 300, [
        { id: 1, durationTicks: 20, animationIndex: 1 },
        { id: 2, durationTicks: 20, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleGeemerAnimation(timeInMilliseconds: number, seed = 0): { index: number, state: number, timeInState: number } {
    // UpdateGeemer @ 0x02153B48 uses state 2/animation 1 when the player
    // enters its proximity radius, state 1/animation 3 while the player
    // remains nearby, and state 3/animation 0 when the player leaves. State
    // 0 then restores the ordinary crawling animation 2.
    const sample = sampleOccasionalEnemyStateMachine(timeInMilliseconds, 30, seed,
        { id: 0, durationTicks: 0, animationIndex: 0 }, 180, 420, [
        { id: 2, durationTicks: 6, animationIndex: 1 },
        { id: 1, durationTicks: 90, animationIndex: 2 },
        { id: 3, durationTicks: 6, animationIndex: 3 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleWarWaspAnimation(timeInMilliseconds: number, seed = 0): { index: number, state: number, timeInState: number } {
    // BeginWarWaspAttack @ 0x02160B6C binds animation 3 at frame 8 and
    // installs a 40-tick attack timer. FinishWarWaspAttackTimer @ 0x02160818
    // resumes the authored patrol target and looping animation 1. The real
    // transition depends on the player; the passive preview supplies it only
    // after a long patrol interval.
    const sample = sampleOccasionalEnemyStateMachine(timeInMilliseconds, 30, seed,
        { id: 0, durationTicks: 0, animationIndex: 0 }, 180, 420, [
        { id: 3, durationTicks: 40, animationIndex: 1 },
        { id: 1, durationTicks: 30, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleBarbedWarWaspAnimation(timeInMilliseconds: number, seed = 0): { index: number, state: number, timeInState: number } {
    // BeginBarbedWarWaspAttackWindup @ 0x021530F4 selects animation 0 at
    // frame 8. ProcessBarbedWarWaspProjectileAttack @ 0x021526A0 then
    // selects animation 2 at frame 10 before emitting the projectile.
    const sample = sampleOccasionalEnemyStateMachine(timeInMilliseconds, 30, seed,
        { id: 0, durationTicks: 0, animationIndex: 0 }, 210, 480, [
        { id: 2, durationTicks: 17, animationIndex: 1 },
        { id: 3, durationTicks: 20, animationIndex: 2 },
        { id: 0, durationTicks: 45, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleGorea2Animation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // BeginGorea2Animation10Attack @ 0x0213F2F8 selects animation 10 at frame 8.
    // The real transition is player-dependent; the passive preview supplies
    // it occasionally and returns to the constructor's animation 7 afterward.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 1, durationTicks: 300, animationIndex: 0 },
        { id: 9, durationTicks: 35, animationIndex: 1 },
        { id: 1, durationTicks: 60, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleGorea1AAnimation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // BeginGorea1AProjectileAttack @ 0x0213666C selects animation 13 at
    // frame 8. ProcessGorea1AProjectileAttack @ 0x02134828 emits the shot at
    // frame 60. The passive preview periodically substitutes the original
    // player-dependent transition, then returns to animation 17 for replay.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 1, durationTicks: 210, animationIndex: 0 },
        { id: 8, durationTicks: 63, animationIndex: 1 },
        { id: 1, durationTicks: 60, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleShriekbatAnimation(timeInMilliseconds: number, seed = 0): { index: number, state: number, timeInState: number } {
    // State 0 normally waits indefinitely for player proximity. The passive
    // viewer periodically supplies that trigger, then follows the animation
    // order selected by the original state callbacks. The one-shot durations
    // are the authored animation lengths.
    const sample = sampleOccasionalEnemyStateMachine(timeInMilliseconds, 30, seed,
        { id: 0, durationTicks: 0, animationIndex: 0 }, 210, 480, [
        { id: 1, durationTicks: 41, animationIndex: 1 },
        { id: 2, durationTicks: 11, animationIndex: 2 },
        { id: 3, durationTicks: 20, animationIndex: 3 },
        { id: 4, durationTicks: 11, animationIndex: 4 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function samplePsychoBitAnimation(timeInMilliseconds: number, seed = 0): { index: number, state: number, timeInState: number } {
    // UpdatePsychoBitDormantState @ 0x021503B0 normally waits for a player-
    // dependent transition. The passive viewer periodically substitutes that
    // trigger, preserving the original dormant (9), tracking (2), and firing
    // (3) states and their selected animations.
    const sample = sampleOccasionalEnemyStateMachine(timeInMilliseconds, 30, seed,
        { id: 9, durationTicks: 0, animationIndex: 0 }, 180, 420, [
        { id: 2, durationTicks: 30, animationIndex: 0 },
        { id: 3, durationTicks: 90, animationIndex: 1 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleSphinkTickAnimation(timeInMilliseconds: number, seed = 0): { index: number, state: number, timeInState: number } {
    // CheckSphinkTickType2EActivationVolume @ 0x02158F60 and
    // ActivateSphinkTickType2E @ 0x021589A0 select animations 6 and 12
    // for the alert and player-directed launch states. Type 2F uses the
    // equivalent callbacks at 0x0215BA30 and 0x0215B470.
    const sample = sampleOccasionalEnemyStateMachine(timeInMilliseconds, 30, seed,
        { id: 0, durationTicks: 0, animationIndex: 0 }, 210, 480, [
        { id: 1, durationTicks: 30, animationIndex: 1 },
        { id: 2, durationTicks: 60, animationIndex: 2 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

function sampleReflectedRange(min: number, max: number, initial: number, step: number, ticks: number): number {
    const range = max - min;
    const period = range * 2;
    let phase = ((initial - min + step * ticks) % period + period) % period;
    if (phase > range)
        phase = period - phase;
    return min + phase;
}

interface MPHAlimbicTurretConfig {
    fireIntervalTicks: number;
    trackingDelayTicks: number;
    minBurstShots: number;
    maxBurstShots: number;
}

const alimbicTurretConfigs: readonly MPHAlimbicTurretConfig[] = [
    { fireIntervalTicks: 5, trackingDelayTicks: 40, minBurstShots: 1, maxBurstShots: 2 },
    { fireIntervalTicks: 3, trackingDelayTicks: 30, minBurstShots: 3, maxBurstShots: 5 },
    { fireIntervalTicks: 3, trackingDelayTicks: 90, minBurstShots: 1, maxBurstShots: 1 },
];

function sampleAlimbicTurretScan(timeInMilliseconds: number): { yaw: number, pitch: number } {
    const ticks = Math.max(0, timeInMilliseconds * 30 / 1000);
    // InitializeAlimbicTurret @ 0x0211EF44 uses parameter table
    // 0x02122D64: yaw -45..45 degrees and pitch 0..60 degrees, with both
    // scan angles advancing one degree per enemy tick and reflecting at bounds.
    return {
        yaw: sampleReflectedRange(-45, 45, 0, 1, ticks) * Math.PI / 180,
        pitch: sampleReflectedRange(0, 60, 0, 1, ticks) * Math.PI / 180,
    };
}

export function sampleAlimbicTurretAim(timeInMilliseconds: number, enemy: MPHEnemySpawnEntity): { yaw: number, pitch: number, state: number } {
    const config = alimbicTurretConfigs[enemy.alimbicTurretConfigId];
    const burstShots = config.minBurstShots +
        (enemy.entityId * 13 & 0x7FFFFFFF) % (config.maxBurstShots - config.minBurstShots + 1);
    // The original target-dependent trigger is supplied periodically by the
    // passive viewer. State order comes from the table at 0x02122CC4:
    // ProcessAlimbicTurretScanState @ 0x0211F51C,
    // ProcessAlimbicTurretAimingState @ 0x0211F4F8,
    // ProcessAlimbicTurretTrackingState @ 0x0211F498,
    // ProcessAlimbicTurretFiringState @ 0x0211F2D0, and
    // ProcessAlimbicTurretRecenterState @ 0x0211F2AC.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 0, durationTicks: 240, animationIndex: 0 },
        { id: 1, durationTicks: 30, animationIndex: 0 },
        { id: 2, durationTicks: config.trackingDelayTicks, animationIndex: 0 },
        { id: 3, durationTicks: burstShots * config.fireIntervalTicks, animationIndex: 0 },
        { id: 4, durationTicks: 30, animationIndex: 0 },
    ]);
    const targetYaw = ((enemy.entityId & 1) === 0 ? 25 : -25) * Math.PI / 180;
    const targetPitch = 25 * Math.PI / 180;
    if (sample.state.id === 0) {
        const scan = sampleAlimbicTurretScan(sample.timeInStateTicks * 1000 / 30);
        return { ...scan, state: 0 };
    }
    const t = smoothstep(0, 1, sample.timeInStateTicks / sample.state.durationTicks);
    if (sample.state.id === 1) {
        const scanExit = sampleAlimbicTurretScan(240 * 1000 / 30);
        return {
            yaw: scanExit.yaw + (targetYaw - scanExit.yaw) * t,
            pitch: scanExit.pitch + (targetPitch - scanExit.pitch) * t,
            state: 1,
        };
    }
    if (sample.state.id === 4)
        return { yaw: targetYaw * (1 - t), pitch: targetPitch * (1 - t), state: 4 };
    return {
        yaw: targetYaw + Math.sin(sample.timeInStateTicks * Math.PI / 30) * 2 * Math.PI / 180,
        pitch: targetPitch,
        state: sample.state.id,
    };
}

export function sampleDripStankAnimation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // ProcessDripStankTurnTimer @ 0x0214DA2C enters state 4 with animation
    // 10; ProcessDripStankIdleFidgetTimer @ 0x0214D9CC enters state 5 with
    // animation 11. BeginDripStankTargetPursuit @ 0x0214E048 then starts
    // the player-reactive path with animation 12; its close pursuit uses
    // animation 9, followed by animation 11 at frame 8 and the animation-3
    // lunge from frame 8. Attached states are omitted because their model
    // transform is owned by the absent player target.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 1, durationTicks: 150, animationIndex: 0 },
        { id: 4, durationTicks: 35, animationIndex: 1 },
        { id: 1, durationTicks: 60, animationIndex: 0 },
        { id: 5, durationTicks: 44, animationIndex: 2 },
        { id: 1, durationTicks: 120, animationIndex: 0 },
        { id: 7, durationTicks: 25, animationIndex: 3 },
        { id: 8, durationTicks: 45, animationIndex: 4 },
        { id: 9, durationTicks: 36, animationIndex: 2 },
        { id: 10, durationTicks: 22, animationIndex: 5 },
        { id: 1, durationTicks: 90, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleGuardBot1Animation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // The real state links enter ProcessGuardBot1TrackPlayerState
    // @ 0x02156EC8 and ProcessGuardBot1FireState @ 0x02156CB0 in response
    // to a nearby player. The passive viewer periodically supplies that
    // stimulus, while retaining the original state IDs and animation choices.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 0, durationTicks: 240, animationIndex: 0 },
        { id: 2, durationTicks: 30, animationIndex: 0 },
        { id: 3, durationTicks: 90, animationIndex: 1 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleGuardBot2Animation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // The original player-volume transition is replaced with a periodic
    // preview, but the seven-state order and animation selections come from
    // the state descriptors at 0x02167B84.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 0, durationTicks: 240, animationIndex: 0 },
        { id: 2, durationTicks: 40, animationIndex: 1 },
        { id: 3, durationTicks: 45, animationIndex: 2 },
        { id: 4, durationTicks: 30, animationIndex: 0 },
        { id: 5, durationTicks: 30, animationIndex: 0 },
        { id: 6, durationTicks: 60, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleAlimbicStatueAnimation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // CheckAlimbicStatueActivation @ 0x0215DBF0 normally depends on a player
    // entering the authored activation volume. The passive viewer supplies
    // that event periodically, then follows the original 17-state graph and
    // its animation selections. Durations use the authored clip lengths and
    // the explicit 5/8/10/15/40-tick state timers.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 0, durationTicks: 240, animationIndex: 0 },
        { id: 1, durationTicks: 30, animationIndex: 1 },
        { id: 2, durationTicks: 15, animationIndex: 2 },
        { id: 4, durationTicks: 25, animationIndex: 3 },
        { id: 3, durationTicks: 15, animationIndex: 3 },
        { id: 6, durationTicks: 10, animationIndex: 3 },
        { id: 7, durationTicks: 25, animationIndex: 4 },
        { id: 8, durationTicks: 35, animationIndex: 5 },
        { id: 10, durationTicks: 3, animationIndex: 6 },
        { id: 11, durationTicks: 38, animationIndex: 7 },
        { id: 12, durationTicks: 25, animationIndex: 3 },
        { id: 15, durationTicks: 15, animationIndex: 2 },
        { id: 16, durationTicks: 30, animationIndex: 1 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleLavaDemonAnimation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // CheckLavaDemonPlayerInActivationVolume @ 0x0215F894 normally begins
    // this sequence. The passive preview periodically supplies that event,
    // then follows the original six-state graph at 0x02168448. Config 0,
    // used by the shipped spawn, attacks 3..6 times; use four deterministic
    // alternating attacks while retaining the original 80-frame clips.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 0, durationTicks: 240, animationIndex: 0 },
        { id: 1, durationTicks: 20, animationIndex: 0 },
        { id: 2, durationTicks: 90, animationIndex: 0 },
        { id: 3, durationTicks: 1, animationIndex: 0 },
        { id: 4, durationTicks: 80, animationIndex: 1 },
        { id: 4, durationTicks: 80, animationIndex: 2 },
        { id: 4, durationTicks: 80, animationIndex: 1 },
        { id: 4, durationTicks: 80, animationIndex: 2 },
        { id: 5, durationTicks: 27, animationIndex: 3 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleBigEyeTurretAnimation(timeInMilliseconds: number): { state: number, timeInAnimation: number } {
    // HandleBigEyeTurretMessage @ 0x021375F4 starts opening on message 0x30.
    // AdvanceBigEyeTurretAnimationFrame @ 0x02136EE8 moves one frame per
    // enemy tick. A shot calls BeginBigEyeTurretClosing @ 0x021372B4; frame
    // zero automatically reverses through ReverseBigEyeTurretClosingAtFrameZero
    // @ 0x0213728C. The viewer periodically substitutes those boss/player
    // events while preserving the original manual frame progression.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 3, durationTicks: 240, animationIndex: 0 },
        { id: 0, durationTicks: 9, animationIndex: 1 },
        { id: 0, durationTicks: 90, animationIndex: 2 },
        { id: 2, durationTicks: 9, animationIndex: 3 },
        { id: 2, durationTicks: 9, animationIndex: 4 },
        { id: 0, durationTicks: 90, animationIndex: 2 },
        { id: 3, durationTicks: 9, animationIndex: 3 },
    ]);
    let frame: number;
    switch (sample.state.animationIndex) {
    case 1:
    case 4:
        frame = sample.timeInStateTicks;
        break;
    case 2:
        frame = 9;
        break;
    case 3:
        frame = 9 - sample.timeInStateTicks;
        break;
    default:
        frame = 0;
        break;
    }
    return { state: sample.state.id, timeInAnimation: frame * 1000 / 30 };
}

export function sampleBigEyeBossAnimation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // UpdateBigEyeBoss @ 0x02133C30 waits in state 0 for player proximity,
    // then follows states 1..4. ApplyBigEyeBossState @ 0x02135D74 selects
    // animation 13 for activation, animation 8 for its open/idle interval,
    // and animation 10 for the firing interval. The viewer periodically
    // substitutes the proximity trigger while preserving that state order.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 0, durationTicks: 240, animationIndex: 0 },
        { id: 1, durationTicks: 115, animationIndex: 1 },
        { id: 2, durationTicks: 30, animationIndex: 0 },
        { id: 3, durationTicks: 120, animationIndex: 0 },
        { id: 4, durationTicks: 90, animationIndex: 2 },
        { id: 3, durationTicks: 150, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleCylinderBossEyeAnimation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // ApplyCylinderBossTurretState @ 0x02135FE0 selects material animation 0
    // for inactive states 1/2/4, animation 3 for active states 0/3/5/6, and
    // animation 5 for destroyed state 9. The viewer periodically substitutes
    // the player/boss transitions and phase reset while preserving those
    // original selections.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 1, durationTicks: 240, animationIndex: 0 },
        { id: 3, durationTicks: 120, animationIndex: 1 },
        { id: 9, durationTicks: 61, animationIndex: 2 },
        { id: 1, durationTicks: 180, animationIndex: 0 },
    ]);
    return {
        index: sample.state.animationIndex,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleCylinderBossAnimation(timeInMilliseconds: number): { index: number, materialIndex: number, state: number, timeInState: number } {
    // The state descriptors at 0x02136E04 link the three Cretaphid phases.
    // CheckAllCylinderBossTurretsDestroyed @ 0x021348E8 selects animation 4;
    // BeginCylinderBossPhaseTransitionAnimation @ 0x02134A14 selects 3;
    // CheckCylinderBossCrystalDestroyed @ 0x02134AB4 selects 0;
    // BeginCylinderBossAnimation1AfterTimer @ 0x02134D3C selects 1; and
    // AdvanceCylinderBossPhaseAfterAnimation @ 0x02134D94 restores 2.
    // The passive preview substitutes deterministic turret/crystal damage.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 0, durationTicks: 180, animationIndex: 0 },
        { id: 1, durationTicks: 180, animationIndex: 0 },
        { id: 4, durationTicks: 51, animationIndex: 1 },
        { id: 5, durationTicks: 120, animationIndex: 2 },
        { id: 7, durationTicks: 61, animationIndex: 3 },
        { id: 8, durationTicks: 51, animationIndex: 4 },
        { id: 10, durationTicks: 180, animationIndex: 0 },
        { id: 13, durationTicks: 51, animationIndex: 1 },
        { id: 14, durationTicks: 120, animationIndex: 2 },
        { id: 16, durationTicks: 61, animationIndex: 3 },
        { id: 17, durationTicks: 51, animationIndex: 4 },
        { id: 19, durationTicks: 180, animationIndex: 0 },
        { id: 22, durationTicks: 51, animationIndex: 1 },
        { id: 23, durationTicks: 120, animationIndex: 2 },
    ]);
    return {
        index: sample.state.animationIndex,
        materialIndex: sample.state.animationIndex === 3 ? 1 : 0,
        state: sample.state.id,
        timeInState: sample.timeInStateTicks * 1000 / 30,
    };
}

export function sampleMochtroidType06Animation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // State 0 lasts ten 15 Hz enemy ticks. ApplyMochtroidType06State
    // @ 0x021669F8 then changes to roaming state 1.
    const materializeDuration = 10 * 1000 / 15;
    if (timeInMilliseconds < materializeDuration)
        return { index: 1, state: 0, timeInState: timeInMilliseconds };
    return { index: 0, state: 1, timeInState: timeInMilliseconds - materializeDuration };
}

export function sampleMochtroidType05Animation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // ApplyMochtroidType05State @ 0x02165D90 starts state 0 on animation 6
    // with a 20-tick countdown. CheckMochtroidType05ActivationTimer
    // @ 0x02165D6C then enters roaming state 1 on animation 0.
    const materializeDuration = 20 * 1000 / 15;
    if (timeInMilliseconds < materializeDuration)
        return { index: 0, state: 0, timeInState: timeInMilliseconds };
    return { index: 1, state: 1, timeInState: timeInMilliseconds - materializeDuration };
}

export function sampleMochtroidType04Animation(timeInMilliseconds: number): { index: number, state: number, timeInState: number } {
    // ApplyMochtroidType04State @ 0x0216545C selects animation 5 for its
    // 30-tick reveal, then CheckMochtroidType04ActivationTimer @ 0x02165438
    // enters state 1 and selects looping animation 0.
    const revealDuration = 30 * 1000 / 15;
    if (timeInMilliseconds < revealDuration)
        return { index: 0, state: 0, timeInState: timeInMilliseconds };
    return { index: 1, state: 1, timeInState: timeInMilliseconds - revealDuration };
}

function samplePatrolPath(dstPosition: vec3, dstFacing: vec3, enemy: MPHEnemySpawnEntity, timeInMilliseconds: number): boolean {
    const points = enemy.patrolPoints;
    if (points.length < 2 || enemy.patrolSpeed <= 0)
        return false;

    // AdvanceWarWaspPatrolWaypoint @ 0x02160E9C
    // AdvanceBarbedWarWaspPatrolWaypoint @ 0x02152DD4
    // State 0 advances the index before choosing its next target.
    let segmentStart = enemy.position;
    let segmentEnd = points[1];
    let nextSegmentEnd = points[2 % points.length];
    let previousDirection = enemy.facing;
    let remainingDistance = timeInMilliseconds * enemy.patrolSpeed / 1000;
    let segmentLength = vec3.distance(segmentStart, segmentEnd);
    if (remainingDistance >= segmentLength) {
        remainingDistance -= segmentLength;
        let loopLength = 0;
        for (let i = 0; i < points.length; i++)
            loopLength += vec3.distance(points[(i + 1) % points.length], points[(i + 2) % points.length]);
        remainingDistance %= loopLength;

        for (let i = 0; i < points.length; i++) {
            segmentStart = points[(i + 1) % points.length];
            segmentEnd = points[(i + 2) % points.length];
            nextSegmentEnd = points[(i + 3) % points.length];
            previousDirection = vec3.sub(vec3.create(), segmentStart, points[i % points.length]);
            segmentLength = vec3.distance(segmentStart, segmentEnd);
            if (remainingDistance < segmentLength)
                break;
            remainingDistance -= segmentLength;
        }
    }

    const t = segmentLength > 0 ? remainingDistance / segmentLength : 0;
    vec3.lerp(dstPosition, segmentStart, segmentEnd, t);

    const direction = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), segmentEnd, segmentStart));
    const nextDirection = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), nextSegmentEnd, segmentEnd));
    vec3.normalize(previousDirection, previousDirection);
    vec3.copy(dstFacing, direction);

    // Smooth the displayed orientation across the neighboring quarter-second
    // of travel instead of snapping it when the state selects its next point.
    const turnDistance = enemy.patrolSpeed * 0.25;
    if (remainingDistance < turnDistance) {
        const turnT = 0.5 + 0.5 * smoothstep(0, turnDistance, remainingDistance);
        vec3.lerp(dstFacing, previousDirection, direction, turnT);
    } else if (segmentLength - remainingDistance < turnDistance) {
        const turnT = 0.5 + 0.5 * smoothstep(0, turnDistance, segmentLength - remainingDistance);
        vec3.lerp(dstFacing, nextDirection, direction, turnT);
    }
    vec3.normalize(dstFacing, dstFacing);
    return true;
}

function sampleClosedPath(dstPosition: vec3, dstFacing: vec3, points: readonly vec3[], distance: number): void {
    let perimeter = 0;
    for (let i = 0; i < points.length; i++)
        perimeter += vec3.distance(points[i], points[(i + 1) % points.length]);
    let remaining = perimeter > 0 ? ((distance % perimeter) + perimeter) % perimeter : 0;
    for (let i = 0; i < points.length; i++) {
        const from = points[i];
        const to = points[(i + 1) % points.length];
        const length = vec3.distance(from, to);
        if (remaining <= length || i === points.length - 1) {
            vec3.lerp(dstPosition, from, to, length > 0 ? remaining / length : 0);
            vec3.sub(dstFacing, to, from);
            if (vec3.squaredLength(dstFacing) !== 0)
                vec3.normalize(dstFacing, dstFacing);
            return;
        }
        remaining -= length;
    }
}

function sampleTemroidPose(dstPosition: vec3, dstFacing: vec3, enemy: MPHEnemySpawnEntity, timeInMilliseconds: number): boolean {
    const points = enemy.patrolPoints;
    if (points.length !== 4 || enemy.patrolSpeed <= 0)
        return false;

    let perimeter = 0;
    for (let i = 0; i < points.length; i++)
        perimeter += vec3.distance(points[i], points[(i + 1) % points.length]);
    const patrolTicks = Math.max(1, Math.ceil(perimeter / enemy.patrolSpeed * 30));
    // The original player-dependent transitions are supplied periodically by
    // the passive viewer. The state order comes from the Temroid descriptors
    // at 0x02168798 and ApplyTemroidState @ 0x02163CE4.
    const sample = sampleEnemyPreviewStateMachine(timeInMilliseconds, 30, [
        { id: 0, durationTicks: patrolTicks, animationIndex: 0 },
        { id: 1, durationTicks: 45, animationIndex: 1 },
        { id: 2, durationTicks: 20, animationIndex: 10 },
        { id: 3, durationTicks: 20, animationIndex: 11 },
        { id: 4, durationTicks: 20, animationIndex: 12 },
        { id: 5, durationTicks: 20, animationIndex: 3 },
        { id: 7, durationTicks: 60, animationIndex: 0 },
    ]);

    if (sample.state.id === 0) {
        sampleClosedPath(dstPosition, dstFacing, points,
            sample.timeInStateTicks / 30 * enemy.patrolSpeed);
        return true;
    }

    const origin = points[0];
    const center = vec3.create();
    for (const point of points)
        vec3.add(center, center, point);
    vec3.scale(center, center, 1 / points.length);
    const outward = vec3.sub(vec3.create(), origin, center);
    if (vec3.squaredLength(outward) === 0)
        vec3.copy(outward, enemy.facing);
    vec3.normalize(outward, outward);
    const approach = vec3.scaleAndAdd(vec3.create(), center, outward, 5);
    const retreat = vec3.scaleAndAdd(vec3.create(), center, outward, 11);
    const attackTarget = vec3.scaleAndAdd(vec3.create(), center, outward, -5);
    const t = sample.timeInStateTicks / sample.state.durationTicks;

    switch (sample.state.id) {
    case 1:
        vec3.lerp(dstPosition, origin, approach, smoothstep(0, 1, t));
        break;
    case 2:
        vec3.copy(dstPosition, approach);
        break;
    case 3:
        vec3.lerp(dstPosition, approach, retreat, t);
        dstPosition[1] += Math.sin(t * Math.PI) * 2;
        break;
    case 4:
        vec3.lerp(dstPosition, retreat, approach, t);
        dstPosition[1] += Math.sin(t * Math.PI) * 2;
        break;
    case 5:
        vec3.lerp(dstPosition, approach, attackTarget, t);
        break;
    default:
        vec3.lerp(dstPosition, attackTarget, origin, smoothstep(0, 1, t));
        break;
    }
    const facingTarget = sample.state.id === 3 ? approach :
        sample.state.id === 7 ? origin : attackTarget;
    vec3.sub(dstFacing, facingTarget, dstPosition);
    if (vec3.squaredLength(dstFacing) !== 0)
        vec3.normalize(dstFacing, dstFacing);
    return true;
}

export function sampleEnemyPose(dstPosition: vec3, dstFacing: vec3, enemy: MPHEnemySpawnEntity, timeInMilliseconds: number): void {
    vec3.copy(dstPosition, enemy.position);
    vec3.copy(dstFacing, enemy.facing);

    if (enemy.enemyType === 0x03 && sampleMochtroidType03Patrol(dstPosition, dstFacing, enemy, timeInMilliseconds))
        return;

    // ProcessTemroidPatrolState @ 0x0216365C follows the four authored
    // corners; the passive preview occasionally enters the original
    // pursuit/attack/return graph.
    if (enemy.enemyType === 0x02 && sampleTemroidPose(dstPosition, dstFacing, enemy, timeInMilliseconds))
        return;

    if (enemy.enemyType === 0x04 && sampleMochtroidType04Hover(dstPosition, dstFacing, enemy, timeInMilliseconds))
        return;

    // ProcessMochtroidType05DormantState @ 0x02165D34 only checks its state
    // link; the constructor's elevated center remains fixed until activation.
    if (enemy.enemyType === 0x05 && enemy.hoverCenter !== null) {
        vec3.copy(dstPosition, enemy.hoverCenter);
        return;
    }

    // ProcessShriekbatDormantState @ 0x02153784 evaluates only the proximity
    // transition. Until a player activates it, the bat hangs at its authored
    // spawn position while animation 4 supplies all visible movement.
    if (enemy.enemyType === 0x0B)
        return;

    if (isWaspEnemy(enemy)) {
        samplePatrolPath(dstPosition, dstFacing, enemy, timeInMilliseconds);
        return;
    }
}

const zoomerCenter = vec3.create();
const zoomerTargetNormal = vec3.create();
const zoomerRotation = quat.create();
const zoomerFallbackAxis = vec3.fromValues(0, 0, 1);

export interface MPHEnemySimulation {
    sample(dstPosition: vec3, dstFacing: vec3, dstUp: vec3, timeInMilliseconds: number): void;
}

export class MochtroidRoamingSimulation implements MPHEnemySimulation {
    private position = vec3.create();
    private previousPosition = vec3.create();
    private facing = vec3.create();
    private previousFacing = vec3.create();
    private targetDirection = vec3.create();
    private velocity = vec3.create();
    private phase = 0;
    private bobBaseY = 0;
    private tickCount = 0;
    private initialRandomSeed: number;
    private randomSeed: number;

    constructor(private enemy: MPHEnemySpawnEntity, private activationTicks: number) {
        this.initialRandomSeed = (enemy.entityId * 0x9E3779B1 + 0x2AA01D31) >>> 0;
        this.randomSeed = this.initialRandomSeed;
        this.reset();
    }

    private nextRange(limit: number): number {
        this.randomSeed = (Math.imul(this.randomSeed, 0x7FF8A3ED) + 0x2AA01D31) >>> 0;
        return Math.floor(limit * (this.randomSeed >>> 16) / 0x10000);
    }

    private chooseBoundedDirection(verticalDirection: number): void {
        const center = this.enemy.hoverCenter!;
        const dx = this.position[0] - center[0];
        const dz = this.position[2] - center[2];
        this.targetDirection[0] = (this.nextRange(0x1000) - 0x800) * FX32_SCALE -
            dx / Math.max(this.enemy.mochtroidRoamingHorizontalRadius, FX32_SCALE);
        this.targetDirection[1] = verticalDirection *
            (this.nextRange(0x800) + 0x800) * FX32_SCALE;
        this.targetDirection[2] = (this.nextRange(0x1000) - 0x800) * FX32_SCALE -
            dz / Math.max(this.enemy.mochtroidRoamingHorizontalRadius, FX32_SCALE);
        vec3.normalize(this.targetDirection, this.targetDirection);
    }

    private reset(): void {
        vec3.copy(this.position, this.enemy.hoverCenter ?? this.enemy.position);
        vec3.copy(this.previousPosition, this.position);
        vec3.copy(this.facing, this.enemy.facing);
        vec3.normalize(this.facing, this.facing);
        vec3.copy(this.previousFacing, this.facing);
        vec3.copy(this.targetDirection, this.facing);
        vec3.set(this.velocity, 0, 0, 0);
        this.phase = 0;
        this.bobBaseY = this.position[1];
        this.tickCount = 0;
        this.randomSeed = this.initialRandomSeed;
        if (this.enemy.enemyType === 0x05) {
            // ApplyMochtroidType05State @ 0x02165D90 chooses three signed
            // random components, normalizes them, and immediately installs
            // velocity 0xCC for active state 1.
            vec3.set(this.targetDirection,
                (this.nextRange(0x1000) - 0x800) * FX32_SCALE,
                (this.nextRange(0x1000) - 0x800) * FX32_SCALE,
                (this.nextRange(0x1000) - 0x800) * FX32_SCALE);
            if (vec3.squaredLength(this.targetDirection) === 0)
                vec3.copy(this.targetDirection, this.enemy.facing);
            vec3.normalize(this.targetDirection, this.targetDirection);
            vec3.scale(this.velocity, this.targetDirection, 0xCC * FX32_SCALE);
        }
    }

    private step(): void {
        // ProcessMochtroidType05ActiveState @ 0x02165780 and
        // CalculateMochtroidType06WanderVelocity @ 0x021664B8 integrate the
        // preceding velocity before computing the next bounded direction and
        // bob correction.
        vec3.copy(this.previousPosition, this.position);
        vec3.copy(this.previousFacing, this.facing);
        vec3.add(this.position, this.position, this.velocity);

        this.phase += this.enemy.hoverBobAngleStep;
        if (this.phase >= 360) {
            this.phase -= 360;
            this.bobBaseY = this.position[1];
        }

        const center = this.enemy.hoverCenter!;
        const dx = this.position[0] - center[0];
        const dz = this.position[2] - center[2];
        if (this.position[1] < center[1])
            this.chooseBoundedDirection(1);
        else if (this.position[1] > center[1] + this.enemy.mochtroidRoamingVerticalRange)
            this.chooseBoundedDirection(-1);
        else if (dx * dx + dz * dz >
            this.enemy.mochtroidRoamingHorizontalRadius * this.enemy.mochtroidRoamingHorizontalRadius) {
            this.targetDirection[0] = -this.targetDirection[0];
            this.targetDirection[1] = (this.nextRange(0x1000) - 0x800) * FX32_SCALE;
            this.targetDirection[2] = -this.targetDirection[2];
            vec3.normalize(this.targetDirection, this.targetDirection);
        }

        // The model-facing vector follows the horizontal target by 1/8 each
        // tick while physical velocity immediately uses the target direction.
        this.facing[0] += (this.targetDirection[0] - this.facing[0]) / 8;
        this.facing[1] = 0;
        this.facing[2] += (this.targetDirection[2] - this.facing[2]) / 8;
        if (vec3.squaredLength(this.facing) !== 0)
            vec3.normalize(this.facing, this.facing);

        vec3.scale(this.velocity, this.targetDirection, 0xCC * FX32_SCALE);
        const bobY = this.bobBaseY +
            Math.sin(this.phase * Math.PI / 180) * this.enemy.hoverBobRadius;
        this.velocity[1] += bobY - this.position[1];
        this.tickCount++;
    }

    public sample(dstPosition: vec3, dstFacing: vec3, dstUp: vec3, timeInMilliseconds: number): void {
        const tick = Math.max(0, timeInMilliseconds * 15 / 1000 - this.activationTicks);
        if (timeInMilliseconds * 15 / 1000 < this.activationTicks) {
            vec3.copy(dstPosition, this.enemy.hoverCenter ?? this.enemy.position);
            vec3.copy(dstFacing, this.enemy.facing);
            vec3.copy(dstUp, this.enemy.up);
            return;
        }
        const targetTick = Math.floor(tick);
        if (targetTick + 1 < this.tickCount)
            this.reset();
        while (this.tickCount < targetTick + 1)
            this.step();
        const t = tick - targetTick;
        vec3.lerp(dstPosition, this.previousPosition, this.position, t);
        vec3.lerp(dstFacing, this.previousFacing, this.facing, t);
        vec3.normalize(dstFacing, dstFacing);
        vec3.copy(dstUp, this.enemy.up);
    }
}

interface GuardBotMovementConfig {
    minSpeed: number;
    maxSpeed: number;
    accelerationTicks: number;
    turnStep: number;
    jumpSpeed: number;
}

// GuardBot1 parameter table @ 0x02167D30. Only fields consumed by its
// passive movement states are reproduced here.
const guardBot1MovementConfigs: readonly GuardBotMovementConfig[] = [
    { minSpeed: 0x333 * FX32_SCALE, maxSpeed: 0x599 * FX32_SCALE, accelerationTicks: 7, turnStep: 10, jumpSpeed: 0x333 * FX32_SCALE },
    { minSpeed: 0x333 * FX32_SCALE, maxSpeed: 0x599 * FX32_SCALE, accelerationTicks: 7, turnStep: 10, jumpSpeed: 0x333 * FX32_SCALE },
    { minSpeed: 0x333 * FX32_SCALE, maxSpeed: 0x599 * FX32_SCALE, accelerationTicks: 7, turnStep: 10, jumpSpeed: 0x333 * FX32_SCALE },
    { minSpeed: 0x4CC * FX32_SCALE, maxSpeed: 0x800 * FX32_SCALE, accelerationTicks: 7, turnStep: 10, jumpSpeed: 0x333 * FX32_SCALE },
    { minSpeed: 0x199 * FX32_SCALE, maxSpeed: 0x400 * FX32_SCALE, accelerationTicks: 7, turnStep: 10, jumpSpeed: 0x333 * FX32_SCALE },
];

const guardBot2MovementConfig: GuardBotMovementConfig = {
    minSpeed: 0x199 * FX32_SCALE,
    maxSpeed: 0x333 * FX32_SCALE,
    accelerationTicks: 3,
    turnStep: 10,
    jumpSpeed: 0x333 * FX32_SCALE,
};

const guardBotCollisionCenter = vec3.create();

export class GuardBotSimulation implements MPHEnemySimulation {
    private position = vec3.create();
    private previousPosition = vec3.create();
    private facing = vec3.create();
    private previousFacing = vec3.create();
    private velocity = vec3.create();
    private target = vec3.create();
    private segmentStart = vec3.create();
    private tickCount = 0;
    private targetDistance = 0;
    private speed = 0;
    private turning = true;
    private targetSide = 1;
    private lastPreviewState = -1;
    private initialRandomSeed: number;
    private randomSeed: number;
    private config: GuardBotMovementConfig;

    constructor(private enemy: MPHEnemySpawnEntity, private collision: MPHCollisionData | null, private previewPhaseMilliseconds: number) {
        this.initialRandomSeed = (enemy.entityId * 0x9E3779B1 + enemy.enemyType * 0x85EBCA6B) >>> 0;
        this.randomSeed = this.initialRandomSeed;
        this.config = enemy.enemyType === 0x23 ? guardBot2MovementConfig :
            guardBot1MovementConfigs[enemy.guardBotConfigId] ?? guardBot1MovementConfigs[0];
        this.reset();
    }

    private nextRange(limit: number): number {
        if (limit <= 0)
            return 0;
        this.randomSeed = (Math.imul(this.randomSeed, 0x7FF8A3ED) + 0x2AA01D31) >>> 0;
        return Math.floor(limit * (this.randomSeed >>> 16) / 0x10000);
    }

    private chooseRoamingTarget(): void {
        // CalculateGuardBot1RoamingTarget @ 0x02157754 alternates the sign
        // of a random 0..180-degree rotation of a random radial offset.
        const center = this.enemy.guardBotRoamingCenter ?? this.enemy.position;
        const radiusFX32 = Math.max(0, Math.round(this.enemy.guardBotRoamingRadius / FX32_SCALE));
        const radius = this.nextRange(radiusFX32) * FX32_SCALE;
        this.targetSide = -this.targetSide;
        const angle = this.nextRange(180 * 0x1000) * FX32_SCALE * this.targetSide * Math.PI / 180;
        this.target[0] = center[0] + Math.cos(angle) * radius;
        this.target[1] = this.position[1];
        this.target[2] = center[2] + Math.sin(angle) * radius;
        vec3.copy(this.segmentStart, this.position);
        this.targetDistance = Math.hypot(this.target[0] - this.position[0], this.target[2] - this.position[2]);
        this.speed = this.config.minSpeed;
        this.turning = true;
    }

    private reset(): void {
        vec3.copy(this.position, this.enemy.position);
        vec3.copy(this.previousPosition, this.position);
        vec3.copy(this.facing, this.enemy.facing);
        this.facing[1] = 0;
        if (vec3.squaredLength(this.facing) === 0)
            vec3.set(this.facing, 0, 0, 1);
        vec3.normalize(this.facing, this.facing);
        vec3.copy(this.previousFacing, this.facing);
        vec3.set(this.velocity, 0, 0, 0);
        this.tickCount = 0;
        this.randomSeed = this.initialRandomSeed;
        this.targetSide = 1;
        this.lastPreviewState = -1;
        this.chooseRoamingTarget();
    }

    private turnTowardTarget(): void {
        const desiredAngle = Math.atan2(this.target[0] - this.position[0], this.target[2] - this.position[2]);
        const currentAngle = Math.atan2(this.facing[0], this.facing[2]);
        let delta = desiredAngle - currentAngle;
        while (delta > Math.PI)
            delta -= Math.PI * 2;
        while (delta < -Math.PI)
            delta += Math.PI * 2;
        const step = this.config.turnStep * Math.PI / 180;
        if (Math.abs(delta) <= step) {
            vec3.set(this.facing, Math.sin(desiredAngle), 0, Math.cos(desiredAngle));
            this.turning = false;
            return;
        }
        const angle = currentAngle + Math.sign(delta) * step;
        vec3.set(this.facing, Math.sin(angle), 0, Math.cos(angle));
    }

    private resolveCollision(): void {
        if (this.collision === null)
            return;

        // UpdateGuardBot1 @ 0x021566C8 uses the common sphere collision path
        // with a radius of 0x800 FX32 and ignores surfaces carrying flag 8.
        const radius = 0x800 * FX32_SCALE;
        vec3.copy(guardBotCollisionCenter, this.position);
        const contacts = queryCollisionSphereContacts(this.collision, guardBotCollisionCenter, radius, 8);
        for (const contact of contacts) {
            const penetration = radius - contact.signedPlaneDistance;
            if (penetration <= 0 || !contact.faceContact || vec3.dot(contact.normal, this.velocity) >= 0)
                continue;
            vec3.scaleAndAdd(this.position, this.position, contact.normal, penetration);
            const inwardSpeed = vec3.dot(this.velocity, contact.normal);
            vec3.scaleAndAdd(this.velocity, this.velocity, contact.normal, -inwardSpeed);
        }
    }

    private step(): void {
        vec3.copy(this.previousPosition, this.position);
        vec3.copy(this.previousFacing, this.facing);

        const previewTime = this.tickCount * 1000 / 30 + this.previewPhaseMilliseconds;
        const preview = this.enemy.enemyType === 0x23 ?
            sampleGuardBot2Animation(previewTime) : sampleGuardBot1Animation(previewTime);
        // CheckGuardBot2RecoveryCollision @ 0x02155FEC chooses the next
        // roaming target while entering the post-impact recovery turn.
        if (this.enemy.enemyType === 0x23 && preview.state === 5 && this.lastPreviewState !== 5)
            this.chooseRoamingTarget();
        if (preview.state <= 1 || preview.state === 6) {
            if (this.turning)
                this.turnTowardTarget();
            else {
                const traveled = Math.hypot(this.position[0] - this.segmentStart[0], this.position[2] - this.segmentStart[2]);
                const remaining = Math.hypot(this.target[0] - this.position[0], this.target[2] - this.position[2]);
                const acceleration = (this.config.maxSpeed - this.config.minSpeed) / this.config.accelerationTicks;
                if (remaining < this.targetDistance * 0.5)
                    this.speed = Math.max(this.config.minSpeed, this.speed - acceleration);
                else
                    this.speed = Math.min(this.config.maxSpeed, this.speed + acceleration);
                this.velocity[0] = this.facing[0] * this.speed;
                this.velocity[2] = this.facing[2] * this.speed;
                if (traveled >= this.targetDistance || remaining <= this.speed) {
                    if (this.collision !== null)
                        this.velocity[1] = this.config.jumpSpeed;
                    this.chooseRoamingTarget();
                    this.velocity[0] = 0;
                    this.velocity[2] = 0;
                }
            }
        } else if (this.enemy.enemyType === 0x23 && preview.state === 3) {
            // BeginGuardBot2ChargeAttack @ 0x02155BA8 starts at 0x999
            // FX32 and ProcessGuardBot2ChargeState @ 0x0215571C subtracts
            // 0x14 each tick, clamped to 0x333.
            const chargeTick = preview.timeInState * 30 / 1000;
            const chargeSpeed = Math.max(0x333, 0x999 - chargeTick * 0x14) * FX32_SCALE;
            // The real state ends on a collision. Without collision data
            // there is no truthful stopping point, so retain the attack
            // animation but keep the authored root in its roaming volume.
            this.velocity[0] = this.collision !== null ? this.facing[0] * chargeSpeed : 0;
            this.velocity[2] = this.collision !== null ? this.facing[2] * chargeSpeed : 0;
        } else {
            this.velocity[0] = 0;
            this.velocity[2] = 0;
        }

        if (this.collision !== null)
            this.velocity[1] -= 0x6E * FX32_SCALE;
        vec3.add(this.position, this.position, this.velocity);
        this.resolveCollision();
        this.lastPreviewState = preview.state;
        this.tickCount++;
    }

    public sample(dstPosition: vec3, dstFacing: vec3, dstUp: vec3, timeInMilliseconds: number): void {
        const tick = Math.max(0, timeInMilliseconds * 30 / 1000);
        const targetTick = Math.floor(tick);
        if (targetTick + 1 < this.tickCount)
            this.reset();
        while (this.tickCount < targetTick + 1)
            this.step();
        const t = tick - targetTick;
        vec3.lerp(dstPosition, this.previousPosition, this.position, t);
        vec3.lerp(dstFacing, this.previousFacing, this.facing, t);
        vec3.normalize(dstFacing, dstFacing);
        vec3.copy(dstUp, this.enemy.up);
    }
}

export class SurfaceCrawlerSimulation implements MPHEnemySimulation {
    private position = vec3.create();
    private previousPosition = vec3.create();
    private facing = vec3.create();
    private previousFacing = vec3.create();
    private normal = vec3.create();
    private previousNormal = vec3.create();
    private targetNormal = vec3.create();
    private velocity = vec3.create();
    private tickCount = 0;
    private turnAngle = 0;
    private turnAngleStep: number;

    constructor(private enemy: MPHEnemySpawnEntity, private collision: MPHCollisionData) {
        this.turnAngleStep = enemy.surfaceCrawlerTurnAngleStep;
        this.reset();
    }

    private reset(): void {
        vec3.copy(this.position, this.enemy.position);
        vec3.copy(this.facing, this.enemy.surfaceCrawlerInitialFacing ?? this.enemy.facing);
        vec3.copy(this.normal, this.enemy.up);
        vec3.normalize(this.normal, this.normal);
        vec3.copy(this.targetNormal, this.normal);
        vec3.copy(this.previousPosition, this.position);
        vec3.copy(this.previousFacing, this.facing);
        vec3.copy(this.previousNormal, this.normal);
        vec3.set(this.velocity, 0, 0, 0);
        this.tickCount = 0;
        this.turnAngle = 0;
        this.turnAngleStep = this.enemy.surfaceCrawlerTurnAngleStep;
    }

    private step(): void {
        // UpdateZoomer @ 0x021614B4; UpdateGeemer @ 0x02153B48
        vec3.copy(this.previousPosition, this.position);
        vec3.copy(this.previousFacing, this.facing);
        vec3.copy(this.previousNormal, this.normal);
        // Enemy movement integrates the velocity written by the preceding
        // update before UpdateZoomer performs its next contact correction.
        vec3.add(this.position, this.position, this.velocity);
        vec3.scaleAndAdd(zoomerCenter, this.position, this.normal, 0.5);
        const contacts = queryCollisionSphereContacts(this.collision, zoomerCenter, 0.5, 8);
        if (contacts.length !== 0) {
            vec3.set(zoomerTargetNormal, 0, 0, 0);
            for (const contact of contacts) {
                const penetration = 0.5 - contact.signedPlaneDistance;
                if (penetration > 0 && penetration < 0.5 && contact.faceContact &&
                    vec3.dot(contact.normal, this.velocity) < 0)
                    vec3.scaleAndAdd(zoomerCenter, zoomerCenter, contact.normal, penetration);

                const previousNormalDot = vec3.dot(this.targetNormal, contact.normal);
                const facingDot = vec3.dot(contact.normal, this.facing);
                if (previousNormalDot < 0xFFE * FX32_SCALE &&
                    ((contact.signedPlaneDistance < 0.5 - 0x198 * FX32_SCALE && facingDot > -0x90 * FX32_SCALE) ||
                    (contact.signedPlaneDistance >= 0.5 - 0x198 * FX32_SCALE && facingDot < 0x90 * FX32_SCALE)))
                    vec3.add(zoomerTargetNormal, zoomerTargetNormal, contact.normal);
            }
            vec3.scaleAndAdd(this.position, zoomerCenter, this.normal, -0.5);
            if (vec3.squaredLength(zoomerTargetNormal) !== 0) {
                vec3.normalize(this.targetNormal, zoomerTargetNormal);
            }
            vec3.lerp(this.normal, this.normal, this.targetNormal, 0x333 * FX32_SCALE);
            vec3.normalize(this.normal, this.normal);

            if (vec3.dot(this.targetNormal, this.normal) > 0xE7F * FX32_SCALE) {
                this.turnAngle += this.turnAngleStep;
                if (Math.abs(this.turnAngle) > this.enemy.surfaceCrawlerTurnLimit)
                    this.turnAngleStep = -this.turnAngleStep;
                quat.setAxisAngle(zoomerRotation, this.normal, this.turnAngleStep * Math.PI / 180);
                vec3.transformQuat(this.facing, this.facing, zoomerRotation);
            }
        }

        vec3.scaleAndAdd(this.facing, this.facing, this.normal, -vec3.dot(this.facing, this.normal));
        if (vec3.squaredLength(this.facing) < 0.000001)
            vec3.cross(this.facing, this.normal, zoomerFallbackAxis);
        vec3.normalize(this.facing, this.facing);

        vec3.scale(this.velocity, this.normal, -0xF5 * FX32_SCALE);
        if (contacts.length !== 0 && vec3.dot(this.targetNormal, this.normal) > 0xE7F * FX32_SCALE)
            vec3.scaleAndAdd(this.velocity, this.velocity, this.facing, 0xCC * FX32_SCALE);
        this.tickCount++;
    }

    public sample(dstPosition: vec3, dstFacing: vec3, dstUp: vec3, timeInMilliseconds: number): void {
        const tick = Math.max(0, timeInMilliseconds * 15 / 1000);
        const targetTick = Math.floor(tick);
        if (targetTick + 1 < this.tickCount)
            this.reset();
        while (this.tickCount < targetTick + 1)
            this.step();
        const t = tick - targetTick;
        vec3.lerp(dstPosition, this.previousPosition, this.position, t);
        vec3.lerp(dstFacing, this.previousFacing, this.facing, t);
        vec3.normalize(dstFacing, dstFacing);
        vec3.lerp(dstUp, this.previousNormal, this.normal, t);
        vec3.normalize(dstUp, dstUp);
    }
}
