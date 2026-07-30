import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { vec3 } from 'gl-matrix';
import { AABB } from '../Geometry.js';
import { assert, readString } from '../util.js';

export interface MPHCollisionPortal {
    geometryNodeName: string | null;
    centroid: readonly [number, number, number] | null;
}

export interface MPHCollisionData {
    portals: MPHCollisionPortal[];
    bounds: AABB;  // collision-file units, multiply by MPH_VIEWER_SCALE for viewer space.
}

const PORTAL_RECORD_SIZE = 0xE0;
const FX32_SCALE = 0x1000;

export function parseMPHCollision(buffer: ArrayBufferSlice): MPHCollisionData {
    const view = buffer.createDataView();
    assert(readString(buffer, 0x00, 0x04) === 'wc01');

    const portalCount = view.getUint32(0x4C, true);
    const portalOffset = view.getUint32(0x50, true);
    assert(portalOffset + portalCount * PORTAL_RECORD_SIZE <= buffer.byteLength);

    // From RelocateAndFilterCollisionData @ 0x0211C1A0
    // Use the collision vertex table as a reachable-room volume for
    // stitched scene visibility.
    const vertexCount = view.getUint32(0x04, true);
    const vertexOffset = view.getUint32(0x08, true);
    assert(vertexOffset + vertexCount * 0x0C <= buffer.byteLength);
    const bounds = new AABB();
    const vertex = vec3.create();
    for (let i = 0; i < vertexCount; i++) {
        const offs = vertexOffset + i * 0x0C;
        vec3.set(vertex,
            view.getInt32(offs + 0x00, true) / FX32_SCALE,
            view.getInt32(offs + 0x04, true) / FX32_SCALE,
            view.getInt32(offs + 0x08, true) / FX32_SCALE);
        bounds.unionPoint(vertex);
    }

    const portals: MPHCollisionPortal[] = [];
    for (let i = 0; i < portalCount; i++) {
        const offs = portalOffset + i * PORTAL_RECORD_SIZE;
        const name = readString(buffer, offs + 0x00, 0x28, true);
        const vertexCount = view.getUint16(offs + 0xDC, true);
        assert(vertexCount <= 4);

        const centroid: [number, number, number] = [0, 0, 0];
        for (let j = 0; j < vertexCount; j++) {
            const vertexOffs = offs + 0x58 + j * 0x0C;
            centroid[0] += view.getInt32(vertexOffs + 0x00, true) / FX32_SCALE;
            centroid[1] += view.getInt32(vertexOffs + 0x04, true) / FX32_SCALE;
            centroid[2] += view.getInt32(vertexOffs + 0x08, true) / FX32_SCALE;
        }
        if (vertexCount !== 0)
            for (let j = 0; j < 3; j++)
                centroid[j] /= vertexCount;

        // pmag portal names map to geomag model nodes.
        const geometryNodeName = name.startsWith('pmag') ? `geo${name.slice(1)}` : null;
        portals.push({ geometryNodeName, centroid: vertexCount !== 0 ? centroid : null });
    }

    return { portals, bounds };
}
