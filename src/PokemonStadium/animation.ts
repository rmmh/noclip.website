import { mat4 } from 'gl-matrix';
import { PokemonAnimation, PokemonAnimationTrack } from './archive.js';

export function readPacked(dataView: DataView, offset: number, index: number, bits: number): number {
    const bitOffset = index * bits;
    const address = offset + ((bitOffset >>> 4) << 1);
    const word = dataView.getUint32(address);
    return (word << (bitOffset & 0x0F)) >> (32 - bits);
}

export function sign16(value: number): number { return (value << 16) >> 16; }

export function sampleSpline(dataView: DataView, offset: number, count: number, frame: number, wide: boolean): number {
    const stride = wide ? 8 : 6;
    const point = (index: number): [number, number] => {
        const address = offset + index * stride;
        return [dataView.getInt16(address), dataView.getInt16(address + 2)];
    };
    const first = point(0), last = point(count - 1);
    if (frame <= first[0]) return first[1];
    if (frame >= last[0]) return last[1];
    let index = 0;
    while (index + 1 < count && frame >= point(index + 1)[0]) index++;
    const a = point(index), b = point(index + 1);
    const duration = b[0] - a[0];
    const t = (frame - a[0]) / duration;
    const t2 = t * t, t3 = t2 * t;
    const outgoingTangent = dataView.getInt16(offset + index * stride + (wide ? 6 : 4));
    const incomingTangent = dataView.getInt16(offset + (index + 1) * stride + 4);
    return a[1] * (2 * t3 - 3 * t2 + 1) + b[1] * (-2 * t3 + 3 * t2) +
        outgoingTangent * (t3 - 2 * t2 + t) * duration / 30 +
        incomingTangent * (t3 - t2) * duration / 30;
}

export function sampleAnimationTrack(dataView: DataView, animation: PokemonAnimation, track: PokemonAnimationTrack, frame: number): [number, number, number] {
    if (animation.Flags & 8) {
        const scale = track.ScaleCount < 2 ? sign16(track.ScaleOffset) / 100
            : sampleSpline(dataView, animation.ScaleValuesOffset + track.ScaleOffset * 2, track.ScaleCount, frame, !!(track.Flags & 4)) / 100;
        let rotation = track.RotationCount < 2 ? sign16(track.RotationOffset) / 10
            : sampleSpline(dataView, animation.RotationValuesOffset + track.RotationOffset * 2, track.RotationCount, frame, !!(track.Flags & 2)) / 10;
        rotation = ((rotation % 360) + 360) % 360;
        const translation = track.TranslationCount < 2 ? sign16(track.TranslationOffset)
            : sampleSpline(dataView, animation.TranslationValuesOffset + track.TranslationOffset * 2,
                track.TranslationCount, frame, !!(track.Flags & 1));
        return [scale, rotation, translation];
    }
    const clamped = (count: number): number => Math.min(frame, count - 1);
    const scale = track.ScaleCount === 1 ? track.ScaleOffset / 1000
        : dataView.getInt16(animation.ScaleValuesOffset + (track.ScaleOffset + clamped(track.ScaleCount)) * 2) / 1000;
    const rotationRaw = track.RotationCount === 1 ? (track.RotationOffset << 20) >> 16
        : readPacked(dataView, animation.RotationValuesOffset, track.RotationOffset + clamped(track.RotationCount), 12) * 16;
    let translation: number;
    if (track.TranslationCount === 1)
        translation = track.Flags & 4 ? (track.TranslationOffset << 16) >> 16 : (track.TranslationOffset << 20) >> 20;
    else
        translation = readPacked(dataView, animation.TranslationValuesOffset,
            track.TranslationOffset + clamped(track.TranslationCount), track.Flags & 4 ? 16 : 12);
    return [scale, rotationRaw * 360 / 0x10000, translation];
}

export function buildLocalMatrix(dst: mat4, translation: number[], rotation: number[], scale: number[]): void {
    const rx = rotation[0] * Math.PI / 180, ry = rotation[1] * Math.PI / 180, rz = rotation[2] * Math.PI / 180;
    const sx = Math.sin(rx), cx = Math.cos(rx), sy = Math.sin(ry), cy = Math.cos(ry), sz = Math.sin(rz), cz = Math.cos(rz);
    // Exact transpose of mtxf_from_translation_rotation_scale's row-vector N64 matrix. Flattening
    // it this way produces the equivalent column-vector gl-matrix value.
    dst[0] = cy * cz * scale[0];
    dst[1] = cy * sz * scale[0];
    dst[2] = -sy * scale[0];
    dst[3] = 0;
    dst[4] = (sx * sy * cz - cx * sz) * scale[1];
    dst[5] = (sx * sy * sz + cx * cz) * scale[1];
    dst[6] = sx * cy * scale[1];
    dst[7] = 0;
    dst[8] = (cx * sy * cz + sx * sz) * scale[2];
    dst[9] = (cx * sy * sz - sx * cz) * scale[2];
    dst[10] = cx * cy * scale[2];
    dst[11] = 0;
    dst[12] = translation[0]; dst[13] = translation[1]; dst[14] = translation[2]; dst[15] = 1;
}
