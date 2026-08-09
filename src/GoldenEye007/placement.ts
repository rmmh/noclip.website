import { mat4, vec3 } from 'gl-matrix';
import type { PropArchive } from './archive.js';
import { PropFlag, SetupType } from './constants.js';

const doorHingeScratch = mat4.create();

export function makePropMatrix(prop: PropArchive, modelScale: number, modelBounds?: number[] | null, placementBounds = modelBounds): mat4 {
    const look = prop.Look;
    const up = prop.Up;
    let rx = up[1] * look[2] - up[2] * look[1];
    let ry = up[2] * look[0] - up[0] * look[2];
    let rz = up[0] * look[1] - up[1] * look[0];
    let len = Math.hypot(rx, ry, rz) || 1;
    rx /= len; ry /= len; rz /= len;
    let ux = look[1] * rz - look[2] * ry;
    let uy = look[2] * rx - look[0] * rz;
    let uz = look[0] * ry - look[1] * rx;
    len = Math.hypot(ux, uy, uz) || 1;
    ux /= len; uy /= len; uz /= len;
    let lx = look[0], ly = look[1], lz = look[2];
    len = Math.hypot(lx, ly, lz) || 1;
    lx /= len; ly /= len; lz /= len;
    let sx = prop.Scale * modelScale, sy = sx, sz = sx;
    if (prop.Type === SetupType.Door && prop.BoundSize != null && modelBounds != null) {
        const modelX = modelBounds[1] - modelBounds[0];
        const modelY = modelBounds[3] - modelBounds[2];
        const modelZ = modelBounds[5] - modelBounds[4];
        // setupDoor deliberately remaps bound-pad Y/Z/X spans onto model
        // X/Y/Z after its two quarter-turn basis rotations.
        if (modelX > 0.000001) sx = prop.BoundSize[1] / modelX;
        if (modelY > 0.000001) sy = prop.BoundSize[2] / modelY;
        if (modelZ > 0.000001) sz = prop.BoundSize[0] / modelZ;
    } else if (prop.BoundSize != null && modelBounds != null && prop.Flags != null && (prop.Flags & 0xF0) !== 0) {
        const modelX = modelBounds[1] - modelBounds[0];
        const modelY = modelBounds[3] - modelBounds[2];
        const modelZ = modelBounds[5] - modelBounds[4];
        let fitX = 1, fitY = 1, fitZ = 1;
        const onscreen = (prop.Flags & 0x02) !== 0;
        if ((prop.Flags & 0x30) !== 0 && modelX > 0.000001)
            fitX = prop.BoundSize[0] / (modelX * modelScale);
        if ((prop.Flags & 0x50) !== 0 && modelY > 0.000001) {
            const fit = prop.BoundSize[onscreen ? 2 : 1] / (modelY * modelScale);
            if (onscreen) fitZ = fit;
            else fitY = fit;
        }
        if ((prop.Flags & 0x90) !== 0 && modelZ > 0.000001) {
            const fit = prop.BoundSize[onscreen ? 1 : 2] / (modelZ * modelScale);
            if (onscreen) fitY = fit;
            else fitZ = fit;
        }
        if ((prop.Flags & 0x10) !== 0) {
            const uniform = Math.min(fitX, fitY, fitZ);
            fitX = fitY = fitZ = uniform;
        } else {
            const largest = Math.max(fitX, fitY, fitZ);
            if ((prop.Flags & 0x20) === 0 && modelX <= 0.000001)
                fitX = largest;
            if ((prop.Flags & 0x40) === 0 && modelY <= 0.000001) {
                if (onscreen) fitZ = largest;
                else fitY = largest;
            }
            if ((prop.Flags & 0x80) === 0 && modelZ <= 0.000001) {
                if (onscreen) fitY = largest;
                else fitZ = largest;
            }
        }
        sx *= fitX;
        sy *= fitY;
        sz *= fitZ;
    }
    const matrix = mat4.fromValues(
        rx, ry, rz, 0,
        ux, uy, uz, 0,
        lx, ly, lz, 0,
        prop.Position[0], prop.Position[1], prop.Position[2], 1,
    );
    if (prop.Type === SetupType.Door) {
        // setupDoor postmultiplies Rz(PI/2) * Rx(PI/2) into the pad basis
        // before applying its model-to-bound-pad axis scales.
        mat4.rotateZ(matrix, matrix, Math.PI / 2);
        mat4.rotateX(matrix, matrix, Math.PI / 2);
    }
    mat4.scale(matrix, matrix, [sx, sy, sz]);
    if (prop.Type !== 1 && prop.Flags != null && modelBounds != null && (prop.Flags & 0x02) !== 0) {
        // sub_GAME_7F040BA0: PROPFLAG_ONSCREEN uses Ry(PI) * Rx(3PI/2),
        // then places bbox Zmin on the authored bound-pad position.
        mat4.rotateY(matrix, matrix, Math.PI);
        mat4.rotateX(matrix, matrix, Math.PI * 1.5);
        matrix[12] -= matrix[8] * modelBounds[4];
        matrix[13] -= matrix[9] * modelBounds[4];
        matrix[14] -= matrix[10] * modelBounds[4];
    } else if (prop.Type !== 1 && prop.Flags != null && modelBounds != null && (prop.Flags & 0x04) !== 0) {
        mat4.rotateZ(matrix, matrix, Math.PI);
        matrix[12] -= matrix[4] * modelBounds[3];
        matrix[13] -= matrix[5] * modelBounds[3];
        matrix[14] -= matrix[6] * modelBounds[3];
    } else if (prop.Type !== 1 && prop.Flags != null && modelBounds != null && (prop.Flags & 0x08) !== 0) {
        matrix[12] -= matrix[4] * modelBounds[2];
        matrix[13] -= matrix[5] * modelBounds[2];
        matrix[14] -= matrix[6] * modelBounds[2];
    } else if (prop.Type !== 1 && prop.FloorY != null && placementBounds != null) {
        let bottom = Infinity;
        for (const x of [placementBounds[0], placementBounds[1]])
            for (const y of [placementBounds[2], placementBounds[3]])
                for (const z of [placementBounds[4], placementBounds[5]])
                    bottom = Math.min(bottom, matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13]);
        if (bottom < prop.FloorY)
            matrix[13] += prop.FloorY - bottom;
    }
    const initiallyOpen = prop.Type === SetupType.Door && prop.Flags != null && (prop.Flags & PropFlag.InitiallyOpen) !== 0 && prop.MaxOpenFraction != null;
    if (initiallyOpen && prop.DoorTravel != null
            && prop.DoorType !== 5 && prop.DoorType !== 6 && prop.DoorType !== 7 && prop.DoorType !== 9) {
        // doorInit initializes PROPFLAG_80000000 doors at maxFrac, and
        // doorBuildRenderMatrix adds travel * openPosition in world space.
        matrix[12] += prop.DoorTravel[0] * prop.MaxOpenFraction!;
        matrix[13] += prop.DoorTravel[1] * prop.MaxOpenFraction!;
        matrix[14] += prop.DoorTravel[2] * prop.MaxOpenFraction!;
    } else if (initiallyOpen && prop.DoorPivot != null && (prop.DoorType === 5 || prop.DoorType === 9)) {
        // doorBuildWorldTransform forms T(pivot) * R * T(-pivot) * closed.
        // Both hinge classes reverse their authored degree angle when the
        // open-to-front flag is set; swinging doors rotate globally about Y,
        // while Aztec chair doors rotate globally about Z.
        const sign = (prop.Flags! & 0x20000000) !== 0 ? -1 : 1;
        const angle = sign * prop.MaxOpenFraction! * Math.PI / 180;
        mat4.identity(doorHingeScratch);
        mat4.translate(doorHingeScratch, doorHingeScratch, prop.DoorPivot as vec3);
        if (prop.DoorType === 9)
            mat4.rotateZ(doorHingeScratch, doorHingeScratch, angle);
        else
            mat4.rotateY(doorHingeScratch, doorHingeScratch, angle);
        mat4.translate(doorHingeScratch, doorHingeScratch, [-prop.DoorPivot[0], -prop.DoorPivot[1], -prop.DoorPivot[2]]);
        mat4.multiply(matrix, doorHingeScratch, matrix);
    }
    return matrix;
}

export function transformBounds(matrix: mat4, bounds: number[]): number[] {
    const result = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
    for (const x of [bounds[0], bounds[1]])
        for (const y of [bounds[2], bounds[3]])
            for (const z of [bounds[4], bounds[5]]) {
                const tx = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
                const ty = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
                const tz = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
                result[0] = Math.min(result[0], tx); result[1] = Math.max(result[1], tx);
                result[2] = Math.min(result[2], ty); result[3] = Math.max(result[3], ty);
                result[4] = Math.min(result[4], tz); result[5] = Math.max(result[5], tz);
            }
    return result;
}


