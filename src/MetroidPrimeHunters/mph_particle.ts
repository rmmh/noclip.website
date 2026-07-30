import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { vec3 } from 'gl-matrix';
import { assert } from '../util.js';

const FX32_SCALE = 1 / 0x1000;

export type MPHParticleScalarEvaluator =
    { kind: 'constant'; value: number } |
    { kind: 'emitterAge' } |
    { kind: 'linear'; keys: readonly [number, number][] } |
    { kind: 'multiply'; a: MPHParticleScalarEvaluator; b: MPHParticleScalarEvaluator };

export type MPHParticleVectorEvaluator =
    { kind: 'constant'; value: readonly [number, number, number] } |
    { kind: 'circular'; period: MPHParticleScalarEvaluator } |
    { kind: 'add'; a: MPHParticleVectorEvaluator; b: MPHParticleVectorEvaluator } |
    { kind: 'scale'; scalar: MPHParticleScalarEvaluator; vector: MPHParticleVectorEvaluator };

export interface MPHParticleEmitter {
    nodeNames: readonly string[];
    duration: number;
    wrapStart: number;
    wrapEnd: number;
    emissionRate: MPHParticleScalarEvaluator;
    initialPosition: MPHParticleVectorEvaluator;
    initialVelocity: MPHParticleVectorEvaluator;
    velocityOverLifetime: MPHParticleVectorEvaluator | null;
    lifetime: MPHParticleScalarEvaluator;
    alpha: MPHParticleScalarEvaluator;
    red: MPHParticleScalarEvaluator;
    green: MPHParticleScalarEvaluator;
    blue: MPHParticleScalarEvaluator;
    size: MPHParticleScalarEvaluator;
}

export interface MPHParticleSystem {
    emitters: readonly MPHParticleEmitter[];
}

function readString(view: DataView, offs: number, length = 0x20): string {
    let result = '';
    for (let i = 0; i < length; i++) {
        const c = view.getUint8(offs + i);
        if (c === 0)
            break;
        result += String.fromCharCode(c);
    }
    return result;
}

function parseScalarEvaluator(view: DataView, offs: number): MPHParticleScalarEvaluator {
    switch (view.getUint32(offs + 0x00, true)) {
    case 23:
        // EvaluateParticleEmitterAge @ 0x02113D6C.
        return { kind: 'emitterAge' };
    case 41: {
        // EvaluateParticleLinearKeyframes @ 0x02113E3C.
        const keys: [number, number][] = [];
        const keyOffs = view.getUint32(offs + 0x04, true);
        for (let i = 0; ; i++) {
            const time = view.getInt32(keyOffs + i * 8 + 0x00, true);
            const value = view.getInt32(keyOffs + i * 8 + 0x04, true);
            if (time === -0x80000000)
                break;
            keys.push([time * FX32_SCALE, value * FX32_SCALE]);
        }
        return { kind: 'linear', keys };
    }
    case 42:
        // EvaluateParticleConstant @ 0x02114064.
        return {
            kind: 'constant',
            value: view.getInt32(view.getUint32(offs + 0x04, true), true) * FX32_SCALE,
        };
    case 48: {
        // MultiplyParticleScalarEvaluators @ 0x02113FA0.
        const args = view.getUint32(offs + 0x04, true);
        return {
            kind: 'multiply',
            a: parseScalarEvaluator(view, view.getUint32(args + 0x00, true)),
            b: parseScalarEvaluator(view, view.getUint32(args + 0x04, true)),
        };
    }
    default:
        throw new Error(`Unsupported MPH particle scalar evaluator ${view.getUint32(offs, true)}`);
    }
}

function parseVectorEvaluator(view: DataView, offs: number): MPHParticleVectorEvaluator {
    switch (view.getUint32(offs + 0x00, true)) {
    case 4: {
        // CopyParticleConstantVector @ 0x02113984.
        const valueOffs = view.getUint32(offs + 0x04, true);
        return {
            kind: 'constant',
            value: [
                view.getInt32(valueOffs + 0x00, true) * FX32_SCALE,
                view.getInt32(valueOffs + 0x04, true) * FX32_SCALE,
                view.getInt32(valueOffs + 0x08, true) * FX32_SCALE,
            ],
        };
    }
    case 13:
        // EvaluateParticleCircularVector @ 0x02113A6C.
        return { kind: 'circular', period: parseScalarEvaluator(view, view.getUint32(offs + 0x04, true)) };
    case 17: {
        // AddParticleVectorEvaluators @ 0x02113684.
        const args = view.getUint32(offs + 0x04, true);
        return {
            kind: 'add',
            a: parseVectorEvaluator(view, view.getUint32(args + 0x00, true)),
            b: parseVectorEvaluator(view, view.getUint32(args + 0x04, true)),
        };
    }
    case 20: {
        // ScaleParticleVectorEvaluator @ 0x02113568.
        const args = view.getUint32(offs + 0x04, true);
        return {
            kind: 'scale',
            scalar: parseScalarEvaluator(view, view.getUint32(args + 0x00, true)),
            vector: parseVectorEvaluator(view, view.getUint32(args + 0x04, true)),
        };
    }
    default:
        throw new Error(`Unsupported MPH particle vector evaluator ${view.getUint32(offs, true)}`);
    }
}

function getParameter(parameters: ReadonlyMap<number, number>, id: number): number | null {
    const offs = parameters.get(id) ?? 0;
    return offs !== 0 ? offs : null;
}

export function parseMPHParticleSystem(buffer: ArrayBufferSlice): MPHParticleSystem {
    const view = buffer.createDataView();
    const emitterCount = view.getUint32(0x14, true);
    const emitterOffsets = view.getUint32(0x18, true);
    const emitters: MPHParticleEmitter[] = [];
    for (let i = 0; i < emitterCount; i++) {
        const offs = view.getUint32(emitterOffsets + i * 4, true);
        const nodeCount = view.getUint32(offs + 0x40, true);
        const nodeOffsets = view.getUint32(offs + 0x44, true);
        const nodeNames: string[] = [];
        for (let j = 0; j < nodeCount; j++)
            nodeNames.push(readString(view, view.getUint32(nodeOffsets + j * 4, true)));

        // CreateParticleEmitterInstance @ 0x021122B0 maps IDs 14..32 from
        // this list into the runtime emitter evaluator slots.
        const parameterCount = view.getUint32(offs + 0x6C, true);
        const parameterOffsets = view.getUint32(offs + 0x70, true);
        const parameters = new Map<number, number>();
        for (let j = 0; j < parameterCount; j++)
            parameters.set(
                view.getUint32(parameterOffsets + j * 8 + 0x00, true),
                view.getUint32(parameterOffsets + j * 8 + 0x04, true),
            );

        const scalar = (id: number, fallback: number): MPHParticleScalarEvaluator => {
            const evaluatorOffs = getParameter(parameters, id);
            return evaluatorOffs !== null ? parseScalarEvaluator(view, evaluatorOffs) : { kind: 'constant', value: fallback };
        };
        const vector = (id: number): MPHParticleVectorEvaluator => {
            const evaluatorOffs = getParameter(parameters, id);
            return evaluatorOffs !== null ? parseVectorEvaluator(view, evaluatorOffs) :
                { kind: 'constant', value: [0, 0, 0] };
        };
        const velocityOverLifetimeOffs = getParameter(parameters, 18);
        assert(view.getUint32(offs + 0x68, true) === 4);
        emitters.push({
            nodeNames,
            duration: view.getInt32(offs + 0x5C, true) * FX32_SCALE,
            wrapStart: view.getInt32(offs + 0x60, true) * FX32_SCALE,
            wrapEnd: view.getInt32(offs + 0x64, true) * FX32_SCALE,
            emissionRate: scalar(14, 0),
            // UpdateParticleSystems @ 0x02112888 evaluates runtime emitter
            // slot 0x5E (parameter 16) into position and slot 0x5D
            // (parameter 15) into velocity when a particle is created.
            initialPosition: vector(16),
            initialVelocity: vector(15),
            velocityOverLifetime: velocityOverLifetimeOffs !== null ?
                parseVectorEvaluator(view, velocityOverLifetimeOffs) : null,
            lifetime: scalar(17, 0),
            alpha: scalar(19, 1),
            red: scalar(20, 1),
            green: scalar(21, 1),
            blue: scalar(22, 1),
            size: scalar(23, 1),
        });
    }
    return { emitters };
}

export function evaluateParticleScalar(evaluator: MPHParticleScalarEvaluator, time: number, duration: number, emitterAge: number): number {
    switch (evaluator.kind) {
    case 'constant':
        return evaluator.value;
    case 'emitterAge':
        return emitterAge;
    case 'multiply':
        return evaluateParticleScalar(evaluator.a, time, duration, emitterAge) *
            evaluateParticleScalar(evaluator.b, time, duration, emitterAge);
    case 'linear': {
        if (evaluator.keys.length === 0)
            return 0;
        const keyTime = duration > 0 ? time / duration : 0;
        let previous = evaluator.keys[0];
        if (keyTime <= previous[0])
            return previous[1];
        for (let i = 1; i < evaluator.keys.length; i++) {
            const next = evaluator.keys[i];
            if (keyTime < next[0]) {
                const t = (keyTime - previous[0]) / (next[0] - previous[0]);
                return previous[1] + (next[1] - previous[1]) * t;
            }
            previous = next;
        }
        return previous[1];
    }
    }
}

export function evaluateParticleVector(dst: vec3, evaluator: MPHParticleVectorEvaluator, time: number, duration: number,
    emitterAge: number): void {
    switch (evaluator.kind) {
    case 'constant':
        dst[0] = evaluator.value[0];
        dst[1] = evaluator.value[1];
        dst[2] = evaluator.value[2];
        return;
    case 'circular': {
        const period = evaluateParticleScalar(evaluator.period, time, duration, emitterAge);
        const angle = period !== 0 ? time / period * Math.PI * 2 : 0;
        dst[0] = Math.sin(angle);
        dst[1] = 0;
        dst[2] = Math.cos(angle);
        return;
    }
    case 'add': {
        const b = vec3.create();
        evaluateParticleVector(dst, evaluator.a, time, duration, emitterAge);
        evaluateParticleVector(b, evaluator.b, time, duration, emitterAge);
        dst[0] += b[0];
        dst[1] += b[1];
        dst[2] += b[2];
        return;
    }
    case 'scale':
        evaluateParticleVector(dst, evaluator.vector, time, duration, emitterAge);
        const scale = evaluateParticleScalar(evaluator.scalar, time, duration, emitterAge);
        dst[0] *= scale;
        dst[1] *= scale;
        dst[2] *= scale;
        return;
    }
}
