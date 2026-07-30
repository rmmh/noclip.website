import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { vec3 } from 'gl-matrix';
import { AABB } from '../Geometry.js';
import { assert, readString } from '../util.js';

export interface MPHCollisionPortal {
    geometryNodeName: string | null;
    centroid: readonly [number, number, number] | null;
}

export interface MPHCollisionSurface {
    normal: vec3;
    distance: number;
    flags: number;
    vertices: vec3[];
}

export interface MPHCollisionContact {
    normal: vec3;
    signedPlaneDistance: number;
    contactDistance: number;
    faceContact: boolean;
}

export interface MPHCollisionData {
    portals: MPHCollisionPortal[];
    surfaces: MPHCollisionSurface[];
    bounds: AABB;  // collision-file units, which match viewer space.
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
    const vertices: vec3[] = [];
    for (let i = 0; i < vertexCount; i++) {
        const offs = vertexOffset + i * 0x0C;
        const vertex = vec3.fromValues(
            view.getInt32(offs + 0x00, true) / FX32_SCALE,
            view.getInt32(offs + 0x04, true) / FX32_SCALE,
            view.getInt32(offs + 0x08, true) / FX32_SCALE);
        vertices.push(vertex);
        bounds.unionPoint(vertex);
    }

    // QueryCollisionSphereContacts @ 0x02117A78
    const planeCount = view.getUint32(0x0C, true);
    const planeOffset = view.getUint32(0x10, true);
    const vertexIndexCount = view.getUint32(0x14, true);
    const vertexIndexOffset = view.getUint32(0x18, true);
    const surfaceCount = view.getUint32(0x1C, true);
    const surfaceOffset = view.getUint32(0x20, true);
    assert(planeOffset + planeCount * 0x10 <= buffer.byteLength);
    assert(vertexIndexOffset + vertexIndexCount * 0x02 <= buffer.byteLength);
    assert(surfaceOffset + surfaceCount * 0x10 <= buffer.byteLength);

    const surfaces: MPHCollisionSurface[] = [];
    for (let i = 0; i < surfaceCount; i++) {
        const offs = surfaceOffset + i * 0x10;
        const planeIndex = view.getUint16(offs + 0x04, true);
        const surfaceVertexCount = view.getUint16(offs + 0x0C, true);
        const firstVertexIndex = view.getUint16(offs + 0x0E, true);
        assert(planeIndex < planeCount);
        assert(firstVertexIndex + surfaceVertexCount < vertexIndexCount);

        const planeOffs = planeOffset + planeIndex * 0x10;
        const surfaceVertices: vec3[] = [];
        for (let j = 0; j < surfaceVertexCount; j++) {
            const vertexIndex = view.getUint16(vertexIndexOffset + (firstVertexIndex + j) * 0x02, true);
            assert(vertexIndex < vertices.length);
            surfaceVertices.push(vertices[vertexIndex]);
        }
        surfaces.push({
            normal: vec3.fromValues(
                view.getInt32(planeOffs + 0x00, true) / FX32_SCALE,
                view.getInt32(planeOffs + 0x04, true) / FX32_SCALE,
                view.getInt32(planeOffs + 0x08, true) / FX32_SCALE),
            distance: view.getInt32(planeOffs + 0x0C, true) / FX32_SCALE,
            flags: view.getUint16(offs + 0x06, true),
            vertices: surfaceVertices,
        });
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

    return { portals, surfaces, bounds };
}

const collisionEdge = vec3.create();
const collisionEdgeNormal = vec3.create();
const collisionClosestPoint = vec3.create();
const collisionDelta = vec3.create();

function distanceToSegment(point: vec3, a: vec3, b: vec3): number {
    vec3.sub(collisionEdge, b, a);
    const edgeLengthSquared = vec3.squaredLength(collisionEdge);
    const t = edgeLengthSquared > 0 ?
        Math.max(0, Math.min(1, vec3.dot(vec3.sub(collisionDelta, point, a), collisionEdge) / edgeLengthSquared)) : 0;
    vec3.scaleAndAdd(collisionClosestPoint, a, collisionEdge, t);
    return vec3.distance(point, collisionClosestPoint);
}

export function queryCollisionSphereContacts(collision: MPHCollisionData, center: vec3, radius: number, flagMask: number): MPHCollisionContact[] {
    const contacts: MPHCollisionContact[] = [];
    for (const surface of collision.surfaces) {
        if ((surface.flags & flagMask) !== 0 || surface.vertices.length < 3)
            continue;

        const planeDistance = vec3.dot(center, surface.normal) - surface.distance;
        // QueryCollisionSphereContacts uses rounded FX32 dot products, so
        // retain the one-LSB boundary contact after converting to floats.
        if (planeDistance <= 0 || planeDistance > radius + 1 / FX32_SCALE)
            continue;

        let inside = true;
        for (let i = 0; i < surface.vertices.length; i++) {
            const a = surface.vertices[i];
            const b = surface.vertices[(i + 1) % surface.vertices.length];
            vec3.normalize(collisionEdge, vec3.sub(collisionEdge, a, b));
            vec3.cross(collisionEdgeNormal, collisionEdge, surface.normal);
            if (vec3.dot(center, collisionEdgeNormal) - vec3.dot(b, collisionEdgeNormal) < -0x80 / FX32_SCALE) {
                inside = false;
                break;
            }
        }

        let contactDistance = planeDistance;
        if (!inside) {
            contactDistance = Infinity;
            for (let i = 0; i < surface.vertices.length; i++)
                contactDistance = Math.min(contactDistance,
                    distanceToSegment(center, surface.vertices[i], surface.vertices[(i + 1) % surface.vertices.length]));
            if (contactDistance > radius)
                continue;
        }

        contacts.push({
            normal: surface.normal,
            signedPlaneDistance: planeDistance,
            contactDistance,
            faceContact: inside,
        });
    }
    return contacts;
}
