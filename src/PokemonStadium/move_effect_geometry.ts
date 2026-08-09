import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { MoveEffectGeometryKind } from './effects.js';

export const moveEffectPreviewFrames = 180;
export type WaveGridKind = 'radialWaveGrid' | 'randomWaveGrid' | 'subtleWaveGrid';
export type PointTrailKind = 'cyanPointTrail' | 'whitePointTrail' | 'yellowPointTrail' | 'prismaticPointTrail';

export interface MoveEffectGeometry {
    Data: ArrayBufferSlice;
    VertexCount: number;
    Triangles: readonly [number, number, number][];
}

/** One update_energy_ring update of the 31-segment ring spawned by start_attacker_energy_ring_effect. */
export function makeCustomRingGeometry(frame: number, mode: 0 | 1, battleScale: number): MoveEffectGeometry {
    const vertexCount = 62;
    const data = new ArrayBuffer(vertexCount * 0x10);
    const view = new DataView(data);
    const triangles: [number, number, number][] = [];
    const age = frame + 1;
    const rise = 1.5 * age;
    for (let i = 0; i < 31; i++) {
        const initialAngle = i * Math.PI * 2 / 30;
        const outerAngle = initialAngle - 0.06 * age;
        // The inner edge updates its phase and angle after emitting each frame;
        // the outer edge updates before emitting it.
        const innerAngle = initialAngle + 0.08 * frame;
        const outerPhase = 0.4 * age;
        const innerPhase = 0.3 * frame;
        const outerWave = 2 * Math.sin(outerAngle + outerPhase + i * 2.4) -
            3 * Math.cos(outerAngle + outerPhase + i * 1.8) + rise;
        const innerWave = 5 * Math.sin(innerAngle + innerPhase + i * 1.6) -
            3 * Math.cos(innerAngle + innerPhase + i * 1.2) + rise;
        const baseY = mode === 0 ? 0 : 100 * battleScale;
        const outerY = Math.max(0, baseY + (mode === 0 ? outerWave : -outerWave) * battleScale);
        const innerY = Math.max(0, baseY + (mode === 0 ? innerWave : -innerWave) * battleScale - 50);
        const divisor = (i % 3) * 2 + 1;
        const blue = Math.floor(0xFF / divisor), green = Math.floor(0x44 / divisor);
        const writeVertex = (index: number, y: number, inner: boolean): void => {
            const offset = index * 0x10;
            view.setInt16(offset + 0, Math.trunc(Math.cos(initialAngle) * 40 * battleScale));
            view.setInt16(offset + 2, Math.trunc(y));
            view.setInt16(offset + 4, Math.trunc(Math.sin(initialAngle) * 40 * battleScale));
            view.setInt16(offset + 8, Math.trunc(i * 0x3000 / 30));
            view.setInt16(offset + 0x0A, inner ? 0x7E0 : 0x20);
            if (inner) {
                view.setUint8(offset + 0x0C, mode === 0 ? 0 : blue); view.setUint8(offset + 0x0D, green);
                view.setUint8(offset + 0x0E, mode === 0 ? blue : 0); view.setUint8(offset + 0x0F, 0);
            } else {
                view.setUint8(offset + 0x0C, mode === 0 ? 0x66 : Math.trunc((blue * 4 + 0x5FA) / 10));
                view.setUint8(offset + 0x0D, mode === 0 ? Math.trunc((green * 6 + 0x3FC) / 10) : Math.trunc((green * 4 + 0x5FA) / 10));
                view.setUint8(offset + 0x0E, mode === 0 ? Math.trunc((blue * 6 + 0x3FC) / 10) : 0x99);
                view.setUint8(offset + 0x0F, mode === 0 ? 0xFF : 0x10);
            }
        };
        writeVertex(i * 2, outerY, false); writeVertex(i * 2 + 1, innerY, true);
        if (i < 30) triangles.push([i * 2, i * 2 + 2, i * 2 + 1], [i * 2 + 2, i * 2 + 3, i * 2 + 1]);
    }
    return { Data: new ArrayBufferSlice(data), VertexCount: vertexCount, Triangles: triangles };
}

/** update_spiral_ribbon_pool's persistent 200-point spiral state. */
export function makeSpiralRibbonGeometries(battleScale: number): MoveEffectGeometry[] {
    const radii = new Float32Array(400); radii.fill(40 * battleScale);
    const geometries: MoveEffectGeometry[] = [];
    let phaseFrame = 0, cycle = 0, pointCount = 0;
    for (let frame = 0; frame < moveEffectPreviewFrames; frame++) {
        phaseFrame++;
        if (phaseFrame > 70) break;
        if (phaseFrame > 30) {
            phaseFrame = 18;
            if (++cycle >= 21) break;
        }
        pointCount = Math.min(200, pointCount + 6);
        const data = new ArrayBuffer(pointCount * 2 * 0x10);
        const view = new DataView(data);
        const triangles: [number, number, number][] = [];
        for (let i = 0; i < pointCount; i++) {
            let verticalOffset: number;
            if (phaseFrame > 30) {
                radii[i] = Math.max(20 * battleScale, radii[i] - 6);
                verticalOffset = Math.sin(((phaseFrame + i) % 200) * Math.PI * 80 / 200) * 0.1;
            } else if (phaseFrame > 25) {
                verticalOffset = Math.sin(((phaseFrame + i) % 200) * Math.PI * 80 / 200) + 2;
                radii[i] += verticalOffset;
            } else if (phaseFrame > 18) {
                radii[i] = Math.max(20 * battleScale, radii[i] - 8);
                verticalOffset = Math.sin(((phaseFrame + i) % 200) * Math.PI * 80 / 200) * 0.1;
            } else {
                verticalOffset = Math.sin(((phaseFrame + i) % 200) * Math.PI * 60 / 200);
                radii[i] += verticalOffset;
            }
            const angle = ((phaseFrame + i) % 200) * Math.PI * 22 / 200;
            const verticalAngle = ((phaseFrame + i) % 200) * Math.PI * 4 / 200;
            const x = Math.sin(angle) * radii[i], baseY = Math.sin(verticalAngle) * 0.7 * radii[i] + verticalOffset;
            const z = Math.cos(angle) * radii[i];
            for (let edge = 0; edge < 2; edge++) {
                const offset = (i * 2 + edge) * 0x10;
                view.setInt16(offset + 0, Math.trunc(x));
                view.setInt16(offset + 2, Math.trunc(baseY + (edge ? 2 * Math.sin(verticalAngle * 3) : 0)));
                view.setInt16(offset + 4, Math.trunc(z));
                view.setInt16(offset + 8, (i * 8) << 5); view.setInt16(offset + 0x0A, edge ? 0x200 : 0);
                view.setUint32(offset + 0x0C, 0xFFFFFFFF);
            }
            if (i + 1 < pointCount) triangles.push([i * 2, i * 2 + 2, i * 2 + 1], [i * 2 + 2, i * 2 + 3, i * 2 + 1]);
        }
        geometries.push({ Data: new ArrayBufferSlice(data), VertexCount: pointCount * 2, Triangles: triangles });
    }
    return geometries;
}

export function makeSpiralRibbonTexture(): ArrayBufferSlice {
    const rows = [0x08,0x08,0x0D,0x0D,0x2F,0x2F,0x6F,0x6F,0x9F,0x9F,0xDF,0xDF,0xFF,0xFF,0xFF,0xFF,
        0xFF,0xFF,0xFF,0xFF,0xDF,0xDF,0x9F,0x9F,0x6F,0x6F,0x2F,0x2F,0x0D,0x0D,0x08,0x08];
    const data = new Uint8Array(8 * 16);
    for (let word = 0; word < rows.length; word++) data.fill(rows[word], word * 4, word * 4 + 4);
    return ArrayBufferSlice.fromView(data);
}

/** The three persistent 16x16 sheets updated by fragment62's funcs 843640A4, 84365288, and 843661D0. */
export function makeWaveGridGeometries(kind: WaveGridKind): MoveEffectGeometry[] {
    const count = 16 * 16;
    const heights = new Float32Array(count);
    const phases = new Float32Array(count);
    let amplitude = kind === 'subtleWaveGrid' ? 0 : 0.01;
    let random = 0x84364A18;
    const addPhaseSource = (sourceX: number, sourceZ: number): void => {
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
            const dx = sourceX - z, dz = sourceZ - x;
            phases[x * 16 + z] += dx === 0 && dz === 0 ? Math.PI / 2 : (Math.PI / 2) / Math.hypot(dx, dz);
        }
    };
    if (kind === 'randomWaveGrid') {
        addPhaseSource(8, 8);
        for (let i = 0; i < 10; i++) {
            random = (Math.imul(random, 0x41C64E6D) + 0x3039) >>> 0; const x = random >>> 16 & 15;
            random = (Math.imul(random, 0x41C64E6D) + 0x3039) >>> 0; const z = random >>> 16 & 15;
            addPhaseSource(x, z);
        }
    }
    const geometries: MoveEffectGeometry[] = [];
    for (let frame = 0; frame < moveEffectPreviewFrames; frame++) {
        const age = frame + 1;
        amplitude = Math.min(kind === 'subtleWaveGrid' ? 0.25 : kind === 'randomWaveGrid' ? 0.5 : 1, amplitude + 0.05);
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
            const index = x * 16 + z;
            if (kind === 'randomWaveGrid') {
                heights[index] = Math.sin(phases[index]) * 0.5 + 1;
                phases[index] += 0.1;
            } else {
                const px = x * 9 - 72, pz = z * 7 - 56;
                const radial = 1 - Math.hypot(px, pz) / 101.8224;
                heights[index] = Math.sin(((age % 20) / 20 + 3 * radial) * Math.PI * 2) * amplitude * radial;
            }
        }
        const alphaLimit = kind === 'subtleWaveGrid' ? 0x50 : 0x80;
        const alpha = Math.min(alphaLimit, age * 10);
        const data = new ArrayBuffer(count * 0x10), view = new DataView(data);
        const triangles: [number, number, number][] = [];
        // calculate_radial_wave_grid_normal and its two copies average the normalized face normals
        // of the four surrounding quadrants, including the final quadrant's
        // reversed winding. Keep that algorithm instead of smoothing the
        // height field with a modern finite-difference normal.
        const normal = (x: number, z: number): [number, number, number] => {
            const sum = [0, 0, 0];
            const edge = (nx: number, nz: number): [number, number, number] => {
                const vx = (nx - x) * 9, vy = heights[nx * 16 + nz] - heights[x * 16 + z], vz = (nz - z) * 7;
                const length = Math.hypot(vx, vy, vz); return [vx / length, vy / length, vz / length];
            };
            const addCross = (ax: number, az: number, bx: number, bz: number, sign = 1): void => {
                const a = edge(ax, az), b = edge(bx, bz);
                sum[0] += sign * (a[1] * b[2] - a[2] * b[1]);
                sum[1] += sign * (a[2] * b[0] - a[0] * b[2]);
                sum[2] += sign * (a[0] * b[1] - a[1] * b[0]);
            };
            if (x > 0 && z >= 1) addCross(x - 1, z, x, z - 1);
            if (x > 0 && z < 15) addCross(x - 1, z, x, z + 1);
            if (x < 15 && z >= 1) addCross(x + 1, z, x, z - 1);
            if (x < 15 && z < 15) addCross(x + 1, z, x, z + 1, -1);
            const length = Math.hypot(sum[0], sum[1], sum[2]);
            return length === 0 ? [0, 1, 0] : [sum[0] / length, sum[1] / length, sum[2] / length];
        };
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
            const index = x * 16 + z, offset = index * 0x10, n = normal(x, z);
            view.setInt16(offset, x * 9 - 72); view.setInt16(offset + 2, Math.trunc(heights[index])); view.setInt16(offset + 4, z * 7 - 56);
            view.setInt16(offset + 8, x * 0x200); view.setInt16(offset + 0x0A, z * 0x200);
            view.setInt8(offset + 0x0C, Math.trunc(n[0] * 120)); view.setInt8(offset + 0x0D, Math.trunc(n[1] * 120));
            view.setInt8(offset + 0x0E, Math.trunc(n[2] * 120)); view.setUint8(offset + 0x0F, alpha);
            if (x < 15 && z < 15) {
                const a = index, b = index + 1, c = index + 16, d = index + 17;
                if (((x * 15 + z) & 1) === 0) triangles.push([b, c, a], [b, d, c]);
                else triangles.push([d, c, a], [b, d, a]);
            }
        }
        geometries.push({ Data: new ArrayBufferSlice(data), VertexCount: count, Triangles: triangles });
    }
    return geometries;
}

export interface PointTrailPointState {
    delay: number;
    position: number[];
    velocity: number[];
    rotation: number;
    radius: number;
}

/** The point-trail subsystem's ten-entry mode-3 trail pool. */
export function makePointTrailGeometries(kind: PointTrailKind, battleScale: number): MoveEffectGeometry[] {
    interface Trail { age: number; points: PointTrailPointState[]; }
    const pool: (Trail | null)[] = Array(10).fill(null);
    const geometries: MoveEffectGeometry[] = [];
    let random = 0x843605C0;
    const nextRandom = (): number => random = (Math.imul(random, 0x41C64E6D) + 0x3039) >>> 0;
    const spawn = (): void => {
        const slot = pool.indexOf(null); if (slot < 0) return;
        const firstRandom = nextRandom();
        const baseVelocity = [8, kind === 'whitePointTrail' ? 6 + (firstRandom % 5) * 0.1 - 0.2 : 6 + (firstRandom % 4) * 0.01 - 0.02,
            0.6 - (nextRandom() % 5) * 0.3];
        const phaseA = nextRandom() % 20 + 2, periodA = nextRandom() % 10 + 4;
        const phaseB = nextRandom() % 20 + 2, periodB = nextRandom() % 10 + 4;
        const points: PointTrailPointState[] = [];
        for (let j = 0; j < 20; j++) {
            const velocity = baseVelocity.slice();
            const primary = Math.sin(((phaseA + j) % periodA) * Math.PI * 2 / periodA) *
                Math.sin(((phaseB + j) % (periodB + 20)) * Math.PI * 2 / (periodB + 20));
            const secondary = Math.sin(((phaseB + j) % periodB) * Math.PI * 2 / periodB);
            if (kind === 'whitePointTrail') { velocity[1] += 2 * primary; velocity[2] += 0.5 * secondary; }
            else { velocity[2] += 2.5 * primary; velocity[1] += 0.5 * secondary; }
            points.push({ delay: j, position: [(j & 1) ? velocity[0] * 0.5 : 0, 0, 0], velocity, rotation: 0,
                radius: battleScale });
        }
        pool[slot] = { age: 0, points };
    };
    spawn();
    for (let frame = 0; frame < moveEffectPreviewFrames; frame++) {
        const callbackFrame = frame + 1;
        if (callbackFrame < 120 && callbackFrame % 7 === 0) spawn();
        for (let slot = 0; slot < pool.length; slot++) {
            const trail = pool[slot]; if (trail === null) continue;
            if (++trail.age > 60) { pool[slot] = null; continue; }
            for (const point of trail.points) {
                if (point.delay > 0) { point.position[0] = point.position[1] = point.position[2] = 0; point.delay--; continue; }
                for (let axis = 0; axis < 3; axis++) point.position[axis] += point.velocity[axis];
                point.rotation += 0.1;
                if (point.velocity[0] > 1) point.velocity[0] -= 0.1;
                else if (point.velocity[0] < -1) point.velocity[0] += 0.1;
                point.velocity[1] = Math.max(-1, point.velocity[1] - 0.2);
                point.position[1] = Math.max(0, point.position[1]);
            }
        }
        const active = pool.filter((trail): trail is Trail => trail !== null);
        const vertexCount = active.length * 40, data = new ArrayBuffer(vertexCount * 0x10), view = new DataView(data);
        const triangles: [number, number, number][] = [];
        let vertex = 0;
        for (const trail of active) {
            const firstVertex = vertex;
            for (let j = 0; j < 20; j++) {
                const point = trail.points[j];
                for (let edge = 0; edge < 2; edge++, vertex++) {
                    const angle = point.rotation + edge * Math.PI, offset = vertex * 0x10;
                    view.setInt16(offset, Math.trunc(point.position[0]));
                    view.setInt16(offset + 2, Math.trunc(Math.max(0, point.position[1] + Math.sin(angle) * point.radius)));
                    view.setInt16(offset + 4, Math.trunc(point.position[2] + Math.cos(angle) * point.radius));
                    view.setInt16(offset + 8, (j * 8) << 5); view.setInt16(offset + 0x0A, edge ? 0x200 : 0);
                    view.setUint32(offset + 0x0C, 0xFFFFFFFF);
                }
                if (j < 19) {
                    const a = firstVertex + j * 2;
                    triangles.push([a, a + 2, a + 1], [a + 2, a + 3, a + 1]);
                }
            }
        }
        geometries.push({ Data: new ArrayBufferSlice(data), VertexCount: vertexCount, Triangles: triangles });
    }
    return geometries;
}

/** spawn_prismatic_point_trail's mode-8 trail used by the move-161 lifecycle. */
export function makePrismaticPointTrailGeometries(): MoveEffectGeometry[] {
    const points = Array.from({ length: 20 }, (_, index): PointTrailPointState => ({
        delay: index, position: [0, 0, 0], velocity: [6, 0, 0], rotation: 0, radius: 2,
    }));
    const geometries: MoveEffectGeometry[] = [];
    const baseColors = [[0xFF, 0x20, 0], [0, 0x20, 0xFF], [0xFF, 0xFF, 0]];
    const radialScale = [1, 1.73205, 1];
    for (let frame = 0; frame < 60; frame++) {
        for (const point of points) {
            if (point.delay > 0) { point.delay--; continue; }
            for (let axis = 0; axis < 3; axis++) point.position[axis] += point.velocity[axis];
            point.rotation += 0.3;
            point.radius = Math.min(20, point.radius + 1);
        }
        const data = new ArrayBuffer(20 * 9 * 0x10), view = new DataView(data);
        const triangles: [number, number, number][] = [];
        for (let pointIndex = 0; pointIndex < 20; pointIndex++) {
            const point = points[pointIndex];
            const alpha = pointIndex === 0 ? 0xFF : Math.trunc(0xB4 * (19 - pointIndex) / 20);
            for (let arm = 0; arm < 3; arm++) for (let radial = 0; radial < 3; radial++) {
                const vertex = pointIndex * 9 + arm * 3 + radial, offset = vertex * 0x10;
                const angle = point.rotation + Math.PI * 2 * radial / 12 + Math.PI * 2 * arm / 3;
                const radius = radialScale[radial] * point.radius;
                view.setInt16(offset, Math.trunc(point.position[0]));
                view.setInt16(offset + 2, Math.trunc(point.position[1] + Math.sin(angle) * radius));
                view.setInt16(offset + 4, Math.trunc(point.position[2] + Math.cos(angle) * radius));
                for (let component = 0; component < 3; component++)
                    view.setUint8(offset + 0x0C + component,
                        Math.trunc((baseColors[arm][component] * (0xFF - alpha) + alpha * 0xFF) / 0xFF));
                view.setUint8(offset + 0x0F, alpha);
            }
        }
        for (let arm = 0; arm < 3; arm++) triangles.push([arm * 3 + 2, arm * 3 + 1, arm * 3]);
        for (let pointIndex = 0; pointIndex < 19; pointIndex++) for (let arm = 0; arm < 3; arm++) {
            const a = pointIndex * 9 + arm * 3, b = a + 9;
            triangles.push([a, b, a + 1], [a + 1, b, b + 1], [a + 1, b + 1, a + 2],
                [a + 2, b + 1, b + 2], [a + 2, b + 2, a], [a, b + 2, b]);
        }
        geometries.push({ Data: new ArrayBufferSlice(data), VertexCount: 180, Triangles: triangles });
    }
    return geometries;
}

export interface ReturningRibbonFrameGeometry {
    Tail: MoveEffectGeometry;
    Heads: MoveEffectGeometry;
}

/** The four-slot pool driven by initialize_returning_ribbon_pool through draw_returning_ribbon_pool. */
export function makeReturningRibbonGeometries(battleScale: number): ReturningRibbonFrameGeometry[] {
    interface RibbonPoint { alpha: number; radius: number; rotation: number; position: number[]; velocity: number[]; }
    interface Ribbon { age: number; sign: number; rotationStep: number; points: RibbonPoint[]; }
    const scale = battleScale * 0.75, pool: (Ribbon | null)[] = Array(4).fill(null), frames: ReturningRibbonFrameGeometry[] = [];
    const spawn = (launch: number): void => {
        const slot = pool.indexOf(null); if (slot < 0) return;
        const angle = ((launch % 3) * Math.PI / 3) + Math.PI / 6;
        const sign = (launch & 1) === 0 ? 1 : -1;
        // The wrapper normalizes (1, sin(angle), cos(angle)) before replacing
        // X with 10 and scaling Y/Z by 20.  Since sin² + cos² is one,
        // the retained Y/Z components each carry the original 1/sqrt(2).
        const normalized = 1 / Math.sqrt(2);
        const velocity = [10, Math.sin(angle) * normalized * 20 * scale,
            Math.cos(angle) * normalized * 20 * scale];
        pool[slot] = { age: 0, sign: 1, rotationStep: sign * 0.3,
            points: Array.from({ length: 15 }, (_, index) => ({
                alpha: Math.trunc(0x80 * (14 - index) / 15), radius: 2, rotation: 0,
                position: [0, 0, 0], velocity: velocity.slice(),
            })) };
    };
    const emptyGeometry = (): MoveEffectGeometry => ({ Data: new ArrayBufferSlice(new ArrayBuffer(0)), VertexCount: 0, Triangles: [] });
    for (let frame = 0; frame < 50; frame++) {
        const callbackFrame = frame + 1;
        if (callbackFrame < 4) spawn(callbackFrame);
        // update_returning_ribbon_effect creates the first ribbon on callback
        // frame one, but does not advance the pool until callback frame two.
        if (callbackFrame >= 2) for (let slot = 0; slot < pool.length; slot++) {
            const ribbon = pool[slot]; if (ribbon === null) continue;
            if (++ribbon.age > 40) { pool[slot] = null; continue; }
            const head = ribbon.points[0];
            const previous = ribbon.points.map((point) => ({
                alpha: point.alpha, radius: point.radius, rotation: point.rotation,
                position: point.position.slice(), velocity: point.velocity.slice(),
            }));
            for (let axis = 0; axis < 3; axis++) head.position[axis] += head.velocity[axis];
            head.rotation += ribbon.rotationStep;
            head.velocity[0] = Math.max(-20, head.velocity[0] - 1.5);
            const velocityAttraction = ribbon.age < 15 ? (15 - ribbon.age) * 0.03 / 15 : 0.03;
            const positionAttraction = ribbon.age < 15 ? ribbon.age * 0.15 / 15 : 0.15;
            for (const axis of [1, 2]) {
                head.velocity[axis] += -head.position[axis] * velocityAttraction;
                head.position[axis] += -head.position[axis] * positionAttraction;
            }
            head.radius = Math.min(13, head.radius + 2);
            for (let index = 1; index < 15; index++) {
                ribbon.points[index].radius = previous[index - 1].radius;
                ribbon.points[index].rotation = previous[index - 1].rotation;
                ribbon.points[index].position = previous[index - 1].position;
                ribbon.points[index].velocity = previous[index - 1].velocity;
            }
        }
        // The wrapper suppresses drawing until its second update.
        if (callbackFrame < 2) { frames.push({ Tail: emptyGeometry(), Heads: emptyGeometry() }); continue; }
        const active = pool.filter((ribbon): ribbon is Ribbon => ribbon !== null);
        const tailData = new ArrayBuffer(active.length * 30 * 0x10), tailView = new DataView(tailData);
        const tailTriangles: [number, number, number][] = [];
        let tailVertex = 0;
        for (const ribbon of active) {
            const first = tailVertex;
            for (const point of ribbon.points) for (let edge = 0; edge < 2; edge++, tailVertex++) {
                const angle = point.rotation + edge * Math.PI, offset = tailVertex * 0x10;
                const radius = point.radius * scale;
                tailView.setInt16(offset, Math.trunc(point.position[0]));
                tailView.setInt16(offset + 2, Math.trunc(Math.max(0, point.position[1] + Math.sin(angle) * radius)));
                tailView.setInt16(offset + 4, Math.trunc(point.position[2] + Math.cos(angle) * radius));
                tailView.setUint8(offset + 0x0C, 0xC0); tailView.setUint8(offset + 0x0D, 0xFF);
                tailView.setUint8(offset + 0x0E, 0xFF); tailView.setUint8(offset + 0x0F, point.alpha);
            }
            for (let segment = 0; segment < 14; segment++) {
                const a = first + segment * 2;
                tailTriangles.push([a, a + 2, a + 1], [a + 2, a + 3, a + 1]);
            }
        }
        const headData = new ArrayBuffer(active.length * 4 * 0x10), headView = new DataView(headData);
        const headTriangles: [number, number, number][] = [];
        const basePositions = [[-30, 0, -20], [10, 0, -20], [-30, 0, 20], [10, 0, 20]];
        const texcoords = [[2048, 0], [0, 0], [2048, 2048], [0, 2048]];
        for (let ribbonIndex = 0; ribbonIndex < active.length; ribbonIndex++) {
            const ribbon = active[ribbonIndex], head = ribbon.points[0];
            const rx = -head.rotation * ribbon.sign, ry = (ribbon.sign * 90 + 90) * Math.PI / 180;
            for (let vertex = 0; vertex < 4; vertex++) {
                let x = basePositions[vertex][0] * scale, y = basePositions[vertex][1] * scale, z = basePositions[vertex][2] * scale;
                const rotatedY = y * Math.cos(rx) - z * Math.sin(rx), rotatedZ = y * Math.sin(rx) + z * Math.cos(rx);
                y = rotatedY; z = rotatedZ;
                const rotatedX = x * Math.cos(ry) + z * Math.sin(ry); z = -x * Math.sin(ry) + z * Math.cos(ry); x = rotatedX;
                const offset = (ribbonIndex * 4 + vertex) * 0x10;
                headView.setInt16(offset, Math.trunc(head.position[0] + x));
                headView.setInt16(offset + 2, Math.trunc(head.position[1] + y));
                headView.setInt16(offset + 4, Math.trunc(head.position[2] + z));
                headView.setInt16(offset + 8, texcoords[vertex][0]); headView.setInt16(offset + 0x0A, texcoords[vertex][1]);
                headView.setUint32(offset + 0x0C, 0xFFFFFFC8);
            }
            const a = ribbonIndex * 4; headTriangles.push([a, a + 2, a + 1], [a + 2, a + 3, a + 1]);
        }
        frames.push({
            Tail: { Data: new ArrayBufferSlice(tailData), VertexCount: tailVertex, Triangles: tailTriangles },
            Heads: { Data: new ArrayBufferSlice(headData), VertexCount: active.length * 4, Triangles: headTriangles },
        });
    }
    return frames;
}

export interface NeedleProjectileFrameGeometry {
    Trail: MoveEffectGeometry;
    Head: MoveEffectGeometry;
}

export const needleHeadPositions = [
    [1,-35,-35],[1,-50,0],[1,0,0],[1,-50,0],[1,-35,-35],[200,0,0],
    [1,0,-49],[1,0,-49],[1,35,-35],[1,35,-35],[1,50,0],[1,50,0],
    [1,35,35],[1,35,35],[1,0,49],[1,0,49],[1,-35,35],[1,-35,35],
] as const;
export const needleHeadNormals = [
    [0x88,0x00,0x00],[0x88,0x00,0x00],[0x88,0x00,0x00],[0x1D,0x8C,0x00],[0x1D,0xAE,0xAE],[0x78,0x00,0x00],
    [0x88,0x00,0x00],[0x1D,0x00,0x8C],[0x88,0x00,0x00],[0x1D,0x52,0xAE],[0x88,0x00,0x00],[0x1D,0x74,0x00],
    [0x88,0x00,0x00],[0x1D,0x52,0x52],[0x88,0x00,0x00],[0x1D,0x00,0x74],[0x88,0x00,0x00],[0x1D,0xAE,0x52],
] as const;
export const needleHeadTriangles: [number, number, number][] = [
    [0,1,2],[3,4,5],[6,0,2],[4,7,5],[8,6,2],[7,9,5],[10,8,2],[9,11,5],
    [12,10,2],[11,13,5],[14,12,2],[13,15,5],[16,14,2],[15,17,5],[1,16,2],[17,3,5],
];

/** The single active trail used by Poison Sting, Twineedle, and Pin Missile. */
export function makeNeedleProjectileGeometries(): NeedleProjectileFrameGeometry[] {
    interface Point { alpha: number; radius: number; rotation: number; position: number[]; velocity: number[]; }
    const points: Point[] = Array.from({ length: 15 }, (_, index) => ({
        alpha: Math.trunc(0xA0 * (14 - index) / 15), radius: 2, rotation: 0,
        position: [0, 0, 0], velocity: [5, 0, 0],
    }));
    const empty = (): MoveEffectGeometry => ({ Data: new ArrayBufferSlice(new ArrayBuffer(0)), VertexCount: 0, Triangles: [] });
    const frames: NeedleProjectileFrameGeometry[] = [];
    for (let frame = 0; frame < 50; frame++) {
        if (frame >= 40) { frames.push({ Trail: empty(), Head: empty() }); continue; }
        const previous = points.map((point) => ({
            alpha: point.alpha, radius: point.radius, rotation: point.rotation,
            position: point.position.slice(), velocity: point.velocity.slice(),
        }));
        const head = points[0];
        for (let axis = 0; axis < 3; axis++) head.position[axis] += head.velocity[axis];
        head.rotation += 0.6;
        head.velocity[0] = Math.min(20, head.velocity[0] + 0.4);
        head.radius = Math.min(4, head.radius + 2);
        for (let index = 1; index < points.length; index++) {
            points[index].radius = previous[index - 1].radius;
            points[index].rotation = previous[index - 1].rotation;
            points[index].position = previous[index - 1].position;
            points[index].velocity = previous[index - 1].velocity;
        }

        const trailData = new ArrayBuffer(30 * 0x10), trailView = new DataView(trailData);
        const trailTriangles: [number, number, number][] = [];
        let trailVertex = 0;
        for (const point of points) for (let edge = 0; edge < 2; edge++, trailVertex++) {
            const angle = point.rotation + edge * Math.PI, offset = trailVertex * 0x10;
            trailView.setInt16(offset, Math.trunc(point.position[0]));
            trailView.setInt16(offset + 2, Math.trunc(Math.max(0, point.position[1] + Math.sin(angle) * point.radius)));
            trailView.setInt16(offset + 4, Math.trunc(point.position[2] + Math.cos(angle) * point.radius));
            trailView.setUint8(offset + 0x0C, 0xC0); trailView.setUint8(offset + 0x0D, 0xFF);
            trailView.setUint8(offset + 0x0E, 0xFF); trailView.setUint8(offset + 0x0F, point.alpha);
        }
        for (let segment = 0; segment < 14; segment++) {
            const vertex = segment * 2;
            trailTriangles.push([vertex, vertex + 2, vertex + 1], [vertex + 2, vertex + 3, vertex + 1]);
        }

        // gNeedleParticleDisplayList is a small lit needle mesh with a constant 4x4 I4 texture.
        const vertexBytes = needleHeadPositions.length * 0x10;
        // noclip decodes through the render tile's 8-byte line stride. The
        // ROM load block contains eight packed bytes, all 0x77; expanding the
        // same constant texel value across the 4-row tile footprint preserves
        // its result while keeping the synthetic data map in bounds.
        const headData = new ArrayBuffer(vertexBytes + 32), headView = new DataView(headData);
        const rotation = -head.rotation, sine = Math.sin(rotation), cosine = Math.cos(rotation);
        for (let vertex = 0; vertex < needleHeadPositions.length; vertex++) {
            const [bx, by, bz] = needleHeadPositions[vertex];
            const y = by * cosine - bz * sine, z = by * sine + bz * cosine;
            const offset = vertex * 0x10;
            headView.setInt16(offset, Math.trunc(head.position[0] + bx * 0.16));
            headView.setInt16(offset + 2, Math.trunc(head.position[1] + y * 0.16));
            headView.setInt16(offset + 4, Math.trunc(head.position[2] + z * 0.16));
            const nx = needleHeadNormals[vertex][0] << 24 >> 24;
            const ny0 = needleHeadNormals[vertex][1] << 24 >> 24, nz0 = needleHeadNormals[vertex][2] << 24 >> 24;
            headView.setInt8(offset + 0x0C, nx);
            headView.setInt8(offset + 0x0D, Math.round(ny0 * cosine - nz0 * sine));
            headView.setInt8(offset + 0x0E, Math.round(ny0 * sine + nz0 * cosine));
            headView.setUint8(offset + 0x0F, 0xFF);
        }
        new Uint8Array(headData, vertexBytes, 32).fill(0x77);
        frames.push({
            Trail: { Data: new ArrayBufferSlice(trailData), VertexCount: 30, Triangles: trailTriangles },
            Head: { Data: new ArrayBufferSlice(headData), VertexCount: needleHeadPositions.length, Triangles: needleHeadTriangles },
        });
    }
    return frames;
}

/** Move 131's three projectiles, emitted four frames apart on descending arcs. */
export function makeArchingNeedleVolleyGeometries(): NeedleProjectileFrameGeometry[] {
    interface Point { alpha: number; radius: number; rotation: number; position: number[]; velocity: number[]; }
    interface Projectile { age: number; rotationStep: number; headAngle: number; points: Point[]; }
    const pool: (Projectile | null)[] = Array(4).fill(null), frames: NeedleProjectileFrameGeometry[] = [];
    const empty = (): MoveEffectGeometry => ({ Data: new ArrayBufferSlice(new ArrayBuffer(0)), VertexCount: 0, Triangles: [] });
    const spawn = (shot: number): void => {
        const slot = pool.indexOf(null); if (slot < 0) return;
        const angle = (3 - shot) * Math.PI / 6 + 20 * Math.PI / 180;
        const velocity = [7 * Math.cos(angle), 10 * Math.sin(angle), 0];
        pool[slot] = { age: 0, rotationStep: (shot & 1 ? -1 : 1) * 0.8, headAngle: 0,
            points: Array.from({ length: 15 }, (_, index) => ({
                alpha: Math.trunc(0x80 * (14 - index) / 15), radius: 2, rotation: 0,
                position: [0, 0, 0], velocity: velocity.slice(),
            })) };
    };
    for (let frame = 0; frame < 50; frame++) {
        const callbackFrame = frame + 1;
        if ((callbackFrame & 3) === 0 && (callbackFrame >> 2) < 4) spawn(callbackFrame >> 2);
        if (callbackFrame >= 2) for (let slot = 0; slot < pool.length; slot++) {
            const projectile = pool[slot]; if (projectile === null) continue;
            if (++projectile.age > 40) { pool[slot] = null; continue; }
            const head = projectile.points[0];
            const previous = projectile.points.map((point) => ({
                alpha: point.alpha, radius: point.radius, rotation: point.rotation,
                position: point.position.slice(), velocity: point.velocity.slice(),
            }));
            for (let axis = 0; axis < 3; axis++) head.position[axis] += head.velocity[axis];
            head.rotation += projectile.rotationStep;
            head.velocity[0] = Math.min(20, head.velocity[0] + 0.4);
            const velocityAttraction = projectile.age < 10 ? (10 - projectile.age) * 0.01 / 10 : 0.01;
            const positionAttraction = projectile.age < 10 ? projectile.age * 0.07 / 10 : 0.07;
            head.velocity[1] += -head.position[1] * velocityAttraction;
            const positionDelta = -head.position[1] * positionAttraction;
            head.position[1] += positionDelta;
            projectile.headAngle = Math.atan2(head.velocity[0], head.velocity[1] + positionDelta);
            head.radius = Math.min(4, head.radius + 2);
            for (let index = 1; index < 15; index++) {
                projectile.points[index].radius = previous[index - 1].radius;
                projectile.points[index].rotation = previous[index - 1].rotation;
                projectile.points[index].position = previous[index - 1].position;
                projectile.points[index].velocity = previous[index - 1].velocity;
            }
        }
        const active = pool.filter((projectile): projectile is Projectile => projectile !== null);
        if (active.length === 0) { frames.push({ Trail: empty(), Head: empty() }); continue; }
        const trailData = new ArrayBuffer(active.length * 30 * 0x10), trailView = new DataView(trailData);
        const trailTriangles: [number, number, number][] = [];
        let trailVertex = 0;
        for (const projectile of active) {
            const first = trailVertex;
            for (const point of projectile.points) for (let edge = 0; edge < 2; edge++, trailVertex++) {
                const angle = point.rotation + edge * Math.PI, offset = trailVertex * 0x10;
                trailView.setInt16(offset, Math.trunc(point.position[0]));
                trailView.setInt16(offset + 2, Math.trunc(Math.max(0, point.position[1] + Math.sin(angle) * point.radius)));
                trailView.setInt16(offset + 4, Math.trunc(point.position[2] + Math.cos(angle) * point.radius));
                trailView.setUint8(offset + 0x0C, 0xD0); trailView.setUint8(offset + 0x0D, 0xFF);
                trailView.setUint8(offset + 0x0E, 0xFF); trailView.setUint8(offset + 0x0F, point.alpha);
            }
            for (let segment = 0; segment < 14; segment++) {
                const vertex = first + segment * 2;
                trailTriangles.push([vertex,vertex + 2,vertex + 1],[vertex + 2,vertex + 3,vertex + 1]);
            }
        }
        const vertexBytes = active.length * needleHeadPositions.length * 0x10;
        const headData = new ArrayBuffer(vertexBytes + 32), headView = new DataView(headData);
        const headTriangles: [number, number, number][] = [];
        for (let projectileIndex = 0; projectileIndex < active.length; projectileIndex++) {
            const projectile = active[projectileIndex], head = projectile.points[0];
            const rx = -head.rotation, sx = Math.sin(rx), cx = Math.cos(rx);
            const rz = projectile.headAngle, sz = Math.sin(rz), cz = Math.cos(rz);
            for (let vertex = 0; vertex < needleHeadPositions.length; vertex++) {
                const [bx, by, bz] = needleHeadPositions[vertex];
                const ry = by * cx - bz * sx, rz0 = by * sx + bz * cx;
                const rx0 = bx * cz - ry * sz, ry0 = bx * sz + ry * cz;
                const offset = (projectileIndex * needleHeadPositions.length + vertex) * 0x10;
                headView.setInt16(offset, Math.trunc(head.position[0] + rx0 * 0.09));
                headView.setInt16(offset + 2, Math.trunc(head.position[1] + ry0 * 0.09));
                headView.setInt16(offset + 4, Math.trunc(head.position[2] + rz0 * 0.09));
                const nx0 = needleHeadNormals[vertex][0] << 24 >> 24;
                const nyBase = needleHeadNormals[vertex][1] << 24 >> 24;
                const nzBase = needleHeadNormals[vertex][2] << 24 >> 24;
                const ny1 = nyBase * cx - nzBase * sx, nz1 = nyBase * sx + nzBase * cx;
                headView.setInt8(offset + 0x0C, Math.round(nx0 * cz - ny1 * sz));
                headView.setInt8(offset + 0x0D, Math.round(nx0 * sz + ny1 * cz));
                headView.setInt8(offset + 0x0E, Math.round(nz1)); headView.setUint8(offset + 0x0F, 0xFF);
            }
            const base = projectileIndex * needleHeadPositions.length;
            for (const [a,b,c] of needleHeadTriangles) headTriangles.push([base + a, base + b, base + c]);
        }
        new Uint8Array(headData, vertexBytes, 32).fill(0x77);
        frames.push({
            Trail: { Data: new ArrayBufferSlice(trailData), VertexCount: trailVertex, Triangles: trailTriangles },
            Head: { Data: new ArrayBufferSlice(headData), VertexCount: active.length * needleHeadPositions.length, Triangles: headTriangles },
        });
    }
    return frames;
}

export interface PlantParticleFrameGeometry {
    Trails: MoveEffectGeometry;
    Heads: MoveEffectGeometry;
}

/** Shared 50-slot two-phase simulation used by Razor Leaf and Petal Dance. */
export function makePlantParticlePoolGeometries(battleScale: number): PlantParticleFrameGeometry[] {
    interface Point { alpha: number; radius: number; rotation: number; position: number[]; velocity: number[]; }
    interface Particle { phase: 0 | 1; age: number; direction: number; scale: number; rotationStep: number;
        acceleration: number[]; points: Point[]; }
    const pool: (Particle | null)[] = Array(50).fill(null), frames: PlantParticleFrameGeometry[] = [];
    let randomState = 0x4D595DF4;
    const random = (limit: number): number => {
        randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
        return randomState % limit;
    };
    const empty = (): MoveEffectGeometry => ({ Data: new ArrayBufferSlice(new ArrayBuffer(0)), VertexCount: 0, Triangles: [] });
    const spawn = (): void => {
        const slot = pool.indexOf(null); if (slot < 0) return;
        const scale = battleScale * 0.5;
        const position = [(random(50) - 25) * battleScale, (random(60) - 30) * battleScale + 80 * scale,
            (random(50) - 25) * battleScale];
        const velocity = [position[0] > 0 ? -10 : 10, 0, 0];
        pool[slot] = { phase: 0, age: 0, direction: position[0] > 0 ? -1 : 1, scale, rotationStep: 0.3,
            acceleration: [0, -2 * scale, 0], points: Array.from({ length: 10 }, (_, index) => ({
                alpha: Math.trunc(0x64 * (9 - index) / 10), radius: 1, rotation: random(120) * Math.PI / 60,
                position: position.slice(), velocity: velocity.slice(),
            })) };
    };
    for (let frame = 0; frame < moveEffectPreviewFrames; frame++) {
        const callbackFrame = frame + 1;
        if ((callbackFrame & 1) === 0) spawn();
        for (let slot = 0; slot < pool.length; slot++) {
            const particle = pool[slot]; if (particle === null) continue;
            particle.age++;
            if (particle.phase === 1 && particle.age > 30) { pool[slot] = null; continue; }
            const head = particle.points[0];
            const previous = particle.points.map((point) => ({
                alpha: point.alpha, radius: point.radius, rotation: point.rotation,
                position: point.position.slice(), velocity: point.velocity.slice(),
            }));
            if (particle.phase === 0) {
                for (let axis = 0; axis < 3; axis++) head.position[axis] += particle.acceleration[axis];
                head.rotation += particle.rotationStep;
                particle.acceleration[0] += Math.sin(head.rotation) * particle.scale;
                particle.acceleration[2] += Math.cos(head.rotation) * particle.scale;
                if (particle.age >= 21) { particle.phase = 1; particle.age = 0; }
            } else {
                for (let axis = 0; axis < 3; axis++) head.position[axis] += head.velocity[axis];
                head.rotation += particle.rotationStep;
                head.velocity[0] = particle.direction > 0 ? Math.min(20, head.velocity[0] + 2) : Math.max(-20, head.velocity[0] - 2);
            }
            head.radius = Math.min(4, head.radius + 2);
            for (let index = 1; index < particle.points.length; index++) {
                particle.points[index].radius = previous[index - 1].radius;
                particle.points[index].rotation = previous[index - 1].rotation;
                particle.points[index].position = previous[index - 1].position;
                particle.points[index].velocity = previous[index - 1].velocity;
            }
        }
        const active = pool.filter((particle): particle is Particle => particle !== null);
        if (active.length === 0) { frames.push({ Trails: empty(), Heads: empty() }); continue; }
        const trailData = new ArrayBuffer(active.length * 20 * 0x10), trailView = new DataView(trailData);
        const trailTriangles: [number, number, number][] = [];
        let trailVertex = 0;
        for (const particle of active) {
            const first = trailVertex;
            for (const point of particle.points) for (let edge = 0; edge < 2; edge++, trailVertex++) {
                const angle = point.rotation + edge * Math.PI, radius = point.radius * particle.scale;
                const offset = trailVertex * 0x10;
                // guRotateRPYF(90, angle, angle) transforms (0,0,r) to
                // (sin(angle)*r, -cos(angle)*r, 0).
                trailView.setInt16(offset, Math.trunc(point.position[0] + Math.sin(angle) * radius));
                trailView.setInt16(offset + 2, Math.trunc(Math.max(0, point.position[1] - Math.cos(angle) * radius)));
                trailView.setInt16(offset + 4, Math.trunc(point.position[2]));
                trailView.setUint8(offset + 0x0C, 0xFF); trailView.setUint8(offset + 0x0D, 0xFF);
                trailView.setUint8(offset + 0x0E, 0xFF); trailView.setUint8(offset + 0x0F, point.alpha);
            }
            for (let segment = 0; segment < 9; segment++) {
                const vertex = first + segment * 2;
                trailTriangles.push([vertex,vertex + 2,vertex + 1],[vertex + 2,vertex + 3,vertex + 1]);
            }
        }
        const headData = new ArrayBuffer(active.length * 4 * 0x10), headView = new DataView(headData);
        const headTriangles: [number, number, number][] = [];
        const base = [[-6,0,-6],[6,0,-6],[-6,0,6],[6,0,6]] as const;
        const texcoords = [[2048,0],[0,0],[2048,2048],[0,2048]] as const;
        for (let particleIndex = 0; particleIndex < active.length; particleIndex++) {
            const particle = active[particleIndex], head = particle.points[0], a = head.rotation;
            const sx = 1, cx = 0, sy = Math.sin(a), cy = Math.cos(a), sz = Math.sin(a), cz = Math.cos(a);
            for (let vertex = 0; vertex < 4; vertex++) {
                const [x, , z] = base[vertex];
                const tx = (cy * cz * x + (cx * sy * cz + sx * sz) * z) * particle.scale;
                const ty = (cy * sz * x + (cx * sy * sz - sx * cz) * z) * particle.scale;
                const tz = (-sy * x + cx * cy * z) * particle.scale;
                const offset = (particleIndex * 4 + vertex) * 0x10;
                headView.setInt16(offset, Math.trunc(head.position[0] + tx));
                headView.setInt16(offset + 2, Math.trunc(head.position[1] + ty));
                headView.setInt16(offset + 4, Math.trunc(head.position[2] + tz));
                headView.setInt16(offset + 8, texcoords[vertex][0]); headView.setInt16(offset + 0x0A, texcoords[vertex][1]);
                headView.setUint32(offset + 0x0C, 0xFFFFFFFF);
            }
            const vertex = particleIndex * 4;
            headTriangles.push([vertex,vertex + 1,vertex + 2],[vertex + 1,vertex + 3,vertex + 2]);
        }
        frames.push({
            Trails: { Data: new ArrayBufferSlice(trailData), VertexCount: trailVertex, Triangles: trailTriangles },
            Heads: { Data: new ArrayBufferSlice(headData), VertexCount: active.length * 4, Triangles: headTriangles },
        });
    }
    return frames;
}

export interface SwiftFrameGeometry { Trails: MoveEffectGeometry; Heads: MoveEffectGeometry; }

/** Swift's 40-slot star pool, including its falling pause and delayed yellow tail. */
export function makeSwiftStarPoolGeometries(battleScale: number): SwiftFrameGeometry[] {
    interface History { position: number[]; rotation: number; }
    interface Star { phase: 0 | 1; age: number; direction: number; scale: number; rotation: number;
        position: number[]; velocity: number[]; history: History[]; }
    const pool: (Star | null)[] = Array(40).fill(null), frames: SwiftFrameGeometry[] = [];
    let randomState = 0x1295A17;
    const random = (limit: number): number => {
        randomState = (Math.imul(randomState, 1103515245) + 12345) >>> 0;
        return randomState % limit;
    };
    const empty = (): MoveEffectGeometry => ({ Data: new ArrayBufferSlice(new ArrayBuffer(0)), VertexCount: 0, Triangles: [] });
    const spawn = (): void => {
        const slot = pool.indexOf(null); if (slot < 0) return;
        const position = [(30 - random(60)) * battleScale, (30 - random(60)) * battleScale + 35,
            (30 - random(60)) * battleScale];
        const rotation = random(100) * Math.PI / 50;
        pool[slot] = { phase: 0, age: 0, direction: position[0] > 0 ? -1 : 1, scale: battleScale * 0.5,
            rotation, position, velocity: [20, 0, 0],
            history: Array.from({ length: 10 }, () => ({ position: position.slice(), rotation })) };
    };
    spawn();
    for (let frame = 0; frame < moveEffectPreviewFrames; frame++) {
        const callbackFrame = frame + 1;
        if (callbackFrame < 0x6EA && callbackFrame % 3 === 0) spawn();
        for (let slot = 0; slot < pool.length; slot++) {
            const star = pool[slot]; if (star === null) continue;
            if (++star.age > 40) { pool[slot] = null; continue; }
            for (let index = star.history.length - 1; index > 0; index--) {
                star.history[index].position = star.history[index - 1].position.slice();
                star.history[index].rotation = star.history[index - 1].rotation;
            }
            if (star.phase === 0) {
                star.position[1] -= 1;
                if (star.age >= 11) star.phase = 1;
                star.rotation += 0.6;
            } else {
                for (let axis = 0; axis < 3; axis++) star.position[axis] += star.velocity[axis];
                star.velocity[0] = star.direction > 0 ? Math.min(20, star.velocity[0] + 2) : Math.max(-20, star.velocity[0] - 2);
                star.rotation += 0.3;
            }
            star.history[0].position = star.position.slice(); star.history[0].rotation = star.rotation;
        }
        const active = pool.filter((star): star is Star => star !== null);
        if (active.length === 0) { frames.push({ Trails: empty(), Heads: empty() }); continue; }
        const tailed = active.filter((star) => star.phase === 1);
        const trailData = new ArrayBuffer(tailed.length * 20 * 0x10), trailView = new DataView(trailData);
        const trailTriangles: [number,number,number][] = [];
        let trailVertex = 0;
        for (const star of tailed) {
            const first = trailVertex, radius = 8 * star.scale;
            for (let index = 0; index < star.history.length; index++) {
                const history = star.history[index];
                for (let edge = 0; edge < 2; edge++, trailVertex++) {
                    const angle = history.rotation + edge * Math.PI, offset = trailVertex * 0x10;
                    trailView.setInt16(offset, Math.trunc(history.position[0] + Math.sin(angle) * radius));
                    trailView.setInt16(offset + 2, Math.trunc(history.position[1] - Math.cos(angle) * radius));
                    trailView.setInt16(offset + 4, Math.trunc(history.position[2]));
                    trailView.setUint8(offset + 0x0C, 0xFF); trailView.setUint8(offset + 0x0D, 0xFF);
                    trailView.setUint8(offset + 0x0E, 0); trailView.setUint8(offset + 0x0F, Math.trunc(0x3C * (9 - index) / 10));
                }
            }
            for (let segment = 0; segment < 9; segment++) {
                const vertex = first + segment * 2;
                trailTriangles.push([vertex,vertex + 1,vertex + 2],[vertex + 1,vertex + 3,vertex + 2]);
            }
        }
        const headData = new ArrayBuffer(active.length * 4 * 0x10), headView = new DataView(headData);
        const headTriangles: [number,number,number][] = [];
        const base = [[-10,0,-10],[10,0,-10],[-10,0,10],[10,0,10]] as const;
        const texcoords = [[2048,0],[0,0],[2048,2048],[0,2048]] as const;
        for (let starIndex = 0; starIndex < active.length; starIndex++) {
            const star = active[starIndex], a = star.rotation;
            const rx = Math.PI / 2, ry = a, rz = star.phase === 0 ? 0 : a;
            const sx = Math.sin(rx), cx = Math.cos(rx), sy = Math.sin(ry), cy = Math.cos(ry), sz = Math.sin(rz), cz = Math.cos(rz);
            for (let vertex = 0; vertex < 4; vertex++) {
                const [x,y,z] = base[vertex];
                const tx = (cy * cz * x + (sx * sy * cz - cx * sz) * y + (cx * sy * cz + sx * sz) * z) * star.scale;
                const ty = (cy * sz * x + (sx * sy * sz + cx * cz) * y + (cx * sy * sz - sx * cz) * z) * star.scale;
                const tz = (-sy * x + sx * cy * y + cx * cy * z) * star.scale;
                const offset = (starIndex * 4 + vertex) * 0x10;
                headView.setInt16(offset, Math.trunc(star.position[0] + tx));
                headView.setInt16(offset + 2, Math.trunc(star.position[1] + ty));
                headView.setInt16(offset + 4, Math.trunc(star.position[2] + tz));
                headView.setInt16(offset + 8, texcoords[vertex][0]); headView.setInt16(offset + 0x0A, texcoords[vertex][1]);
                headView.setUint32(offset + 0x0C, 0xFFFFFFC8);
            }
            const vertex = starIndex * 4;
            headTriangles.push([vertex,vertex + 2,vertex + 1],[vertex + 2,vertex + 3,vertex + 1]);
        }
        frames.push({
            Trails: { Data: new ArrayBufferSlice(trailData), VertexCount: trailVertex, Triangles: trailTriangles },
            Heads: { Data: new ArrayBufferSlice(headData), VertexCount: active.length * 4, Triangles: headTriangles },
        });
    }
    return frames;
}

export function makeMoveEffectGeometry(kind: MoveEffectGeometryKind): MoveEffectGeometry {
    let positions: readonly [number, number, number][];
    let texcoords: readonly [number, number][];
    let colors: readonly number[] = [0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF];
    let triangles: readonly [number, number, number][] = [[0, 1, 2], [0, 2, 3]];
    switch (kind) {
    case 'center24':
        positions = [[-12,-12,0],[11,-12,0],[11,11,0],[-12,11,0]];
        texcoords = [[0,736],[736,736],[736,0],[0,0]]; break;
    case 'bottom32':
        positions = [[-16,0,0],[15,0,0],[15,31,0],[-16,31,0]];
        texcoords = [[0,992],[992,992],[992,0],[0,0]]; break;
    case 'right32':
        positions = [[0,-16,0],[31,-16,0],[31,15,0],[0,15,0]];
        texcoords = [[0,992],[992,992],[992,0],[0,0]]; break;
    case 'triangle32':
        positions = [[0,18,0],[-16,-9,0],[16,-9,0]];
        texcoords = [[480,0],[992,992],[0,992]]; colors = colors.slice(0, 3); triangles = [[0,1,2]]; break;
    case 'tall64':
        positions = [[-16,-32,0],[15,-32,0],[15,31,0],[-16,31,0]];
        texcoords = [[0,2016],[992,2016],[992,0],[0,0]]; break;
    case 'bottom64':
        positions = [[-16,0,0],[15,0,0],[15,63,0],[-16,63,0]];
        texcoords = [[0,2016],[992,2016],[992,0],[0,0]]; break;
    case 'center64':
        positions = [[-32,-32,0],[31,-32,0],[31,31,0],[-32,31,0]];
        texcoords = [[0,2016],[2016,2016],[2016,0],[0,0]]; break;
    case 'ground128':
        positions = [[-64,0,63],[63,0,63],[63,0,-64],[-64,0,-64]];
        texcoords = [[0,0],[4064,0],[4064,4064],[0,4064]]; break;
    case 'screen320x240':
        positions = [[-160,-120,0],[160,-120,0],[160,120,0],[-160,120,0]];
        texcoords = [[0,4096],[4096,4096],[4096,0],[0,0]];
        colors = [0x000078FF, 0x000078FF, 0x000078FF, 0x000078FF]; break;
    case 'screen320x240Double':
        positions = [[-160,-120,0],[160,-120,0],[160,120,0],[-160,120,0]];
        texcoords = [[0,8192],[8192,8192],[8192,0],[0,0]];
        colors = [0x000078FF, 0x000078FF, 0x000078FF, 0x000078FF]; break;
    case 'screen320x240Quarter':
        positions = [[-160,-120,0],[160,-120,0],[160,120,0],[-160,120,0]];
        texcoords = [[0,1024],[1024,1024],[1024,0],[0,0]];
        colors = [0x000078FF, 0x000078FF, 0x000078FF, 0x000078FF]; break;
    case 'bottom128x64':
        positions = [[-64,-63,0],[62,-63,0],[62,0,0],[-64,0,0]];
        texcoords = [[0,2016],[2016,2016],[2016,0],[0,0]]; break;
    case 'beam32':
        positions = [[-16,96,0],[15,96,0],[15,0,0],[-16,0,0]];
        texcoords = [[0,3040],[992,3040],[992,0],[0,0]]; break;
    case 'beam16':
        positions = [[-8,96,0],[7,96,0],[7,0,0],[-8,0,0]];
        texcoords = [[0,3040],[992,3040],[992,0],[0,0]]; break;
    case 'beam8':
        positions = [[-4,96,0],[3,96,0],[3,0,0],[-4,0,0]];
        texcoords = [[0,3040],[992,3040],[992,0],[0,0]]; break;
    case 'beamTriangle8':
        positions = [[0,0,0],[7,255,0],[-8,255,0]];
        texcoords = [[224,0],[480,8160],[0,8160]]; colors = colors.slice(0, 3); triangles = [[0,1,2]]; break;
    case 'beamTriangle32':
        positions = [[0,0,0],[31,255,0],[-32,255,0]];
        texcoords = [[224,0],[480,8160],[0,8160]]; colors = colors.slice(0, 3); triangles = [[0,1,2]]; break;
    case 'tall96':
        positions = [[-16,-48,0],[15,-48,0],[15,47,0],[-16,47,0]];
        texcoords = [[0,3040],[992,3040],[992,0],[0,0]]; break;
    case 'color32':
        positions = [[-16,-16,0],[15,-16,0],[15,15,0],[-16,15,0]];
        texcoords = [[0,992],[992,992],[992,0],[0,0]];
        colors = [0xFF0000FF, 0xFFFF00FF, 0x00FF00FF, 0x00FFFFFF]; break;
    default:
        positions = [[-16,-16,0],[15,-16,0],[15,15,0],[-16,15,0]];
        texcoords = [[0,992],[992,992],[992,0],[0,0]]; break;
    }
    const data = new ArrayBuffer(positions.length * 0x10);
    const view = new DataView(data);
    for (let i = 0; i < positions.length; i++) {
        const offset = i * 0x10;
        view.setInt16(offset, positions[i][0]); view.setInt16(offset + 2, positions[i][1]); view.setInt16(offset + 4, positions[i][2]);
        view.setInt16(offset + 8, texcoords[i][0]); view.setInt16(offset + 0x0A, texcoords[i][1]);
        view.setUint32(offset + 0x0C, colors[i]);
    }
    return { Data: new ArrayBufferSlice(data), VertexCount: positions.length, Triangles: triangles };
}
