import { mat4 } from 'gl-matrix';
import ArrayBufferSlice from '../ArrayBufferSlice.js';

export interface GeoPart {
    displayList: number;
    matrix: mat4;
    billboard: boolean;
    layer: number;
    animated: boolean;
}

export interface GeoAnimationPose {
    rootTranslation: [number, number, number];
    rotations: [number, number, number][];
}

export interface GeoAnimation {
    frameCount: number;
    looping: boolean;
    poses: GeoAnimationPose[];
}

export function decodeAnimation(segmentBuffers: ArrayBufferSlice[], address: number): GeoAnimation | null {
    const buffer = segmentBuffers[address >>> 24];
    if (buffer === undefined) return null;
    const view = buffer.createDataView();
    const offset = address & 0x00FFFFFF;
    if (offset + 0x18 > buffer.byteLength) return null;
    const flags = view.getInt16(offset);
    const frameCount = view.getInt16(offset + 8);
    const partCount = view.getInt16(offset + 0x0A);
    const valuesAddress = view.getUint32(offset + 0x0C);
    const indexAddress = view.getUint32(offset + 0x10);
    const valuesBuffer = segmentBuffers[valuesAddress >>> 24], indexBuffer = segmentBuffers[indexAddress >>> 24];
    if (frameCount <= 0 || partCount <= 0 || valuesBuffer === undefined || indexBuffer === undefined) return null;
    const values = valuesBuffer.createDataView(), indices = indexBuffer.createDataView();
    const valuesBase = valuesAddress & 0x00FFFFFF, indexBase = indexAddress & 0x00FFFFFF;
    const sample = (attribute: number, frame: number): number => {
        const count = indices.getUint16(indexBase + attribute * 4);
        const start = indices.getUint16(indexBase + attribute * 4 + 2);
        return values.getInt16(valuesBase + (start + Math.min(frame, count - 1)) * 2);
    };
    const poses: GeoAnimationPose[] = [];
    for (let frame = 0; frame < frameCount; frame++) {
        const translateX = (flags & 0x10) !== 0 ? sample(0, frame) : 0;
        const translateY = (flags & 0x08) !== 0 ? sample(1, frame) : (flags & 0x40) !== 0 ? 0 : sample(1, frame);
        const translateZ = (flags & 0x10) !== 0 ? sample(2, frame) : 0;
        const rootTranslation: [number, number, number] = (flags & 0x08) !== 0 ? [0, translateY, 0] : (flags & 0x10) !== 0 ? [translateX, 0, translateZ] : (flags & 0x40) !== 0 ? [0, 0, 0] : [sample(0, frame), sample(1, frame), sample(2, frame)];
        const rotations: [number, number, number][] = [];
        for (let part = 0; part < partCount; part++) {
            const attribute = 3 + part * 3;
            rotations.push([sample(attribute, frame) * Math.PI / 0x8000, sample(attribute + 1, frame) * Math.PI / 0x8000, sample(attribute + 2, frame) * Math.PI / 0x8000]);
        }
        poses.push({ rootTranslation, rotations });
    }
    return { frameCount, looping: (flags & 0x01) === 0, poses };
}

export function decodeAnimationTable(segmentBuffers: ArrayBufferSlice[], address: number, index: number): GeoAnimation | null {
    const buffer = segmentBuffers[address >>> 24];
    const offset = (address & 0x00FFFFFF) + index * 4;
    if (buffer === undefined || offset + 4 > buffer.byteLength) return null;
    return decodeAnimation(segmentBuffers, buffer.createDataView().getUint32(offset));
}

interface GeoNode {
    matrix: mat4;
    billboard: boolean;
    displayList: number;
    layer: number;
    switchCase: boolean;
    switchFunction: number;
    animated: boolean;
    children: GeoNode[];
}

function readS16(view: DataView, offs: number): number { return view.getInt16(offs); }

export function parseGeoLayout(segmentBuffers: ArrayBufferSlice[], address: number, animationPose?: GeoAnimationPose, switchCaseIndex: number = 0, switchFunctionAddress?: number): GeoPart[] {
    const recursion = new Set<number>();

    const parseList = (startAddress: number): GeoNode[] => {
        if (recursion.has(startAddress)) return [];
        recursion.add(startAddress);
        const segment = startAddress >>> 24;
        const buffer = segmentBuffers[segment];
        if (buffer === undefined) { recursion.delete(startAddress); return []; }
        const view = buffer.createDataView();
        const nodes: GeoNode[] = [];
        let p = startAddress & 0x00FFFFFF;
        let overrideNextTranslation: [number, number, number] | undefined;
        while (p + 4 <= buffer.byteLength) {
            const op = view.getUint8(p), param = view.getUint8(p + 1);
            if (op === 0x01 || op === 0x03 || op === 0x05) { p += 4; break; }
            if (op === 0x04) { p += 4; continue; }
            if (op === 0x00 || op === 0x02) {
                const target = view.getUint32(p + 4);
                nodes.push(...parseList(target));
                p += 8;
                if (op === 0x02 && param === 0) break;
                continue;
            }

            const node: GeoNode = { matrix: mat4.create(), billboard: false, displayList: 0, layer: param & 0x0F, switchCase: op === 0x0E, switchFunction: op === 0x0E ? view.getUint32(p + 4) : 0, animated: op === 0x13, children: [] };
            let size = 4;
            if (op === 0x08) size = 12;
            else if (op === 0x0A) size = param !== 0 ? 12 : 8;
            else if (op === 0x0D || op === 0x0E || op === 0x16 || op === 0x19 || op === 0x1A || op === 0x1E) size = 8;
            else if (op === 0x0F) size = 20;
            else if (op === 0x10) {
                const layout = param & 0x70;
                if (layout === 0) {
                    const translation = overrideNextTranslation ?? [readS16(view, p + 4), readS16(view, p + 6), readS16(view, p + 8)];
                    overrideNextTranslation = undefined;
                    mat4.translate(node.matrix, node.matrix, translation);
                    mat4.rotateX(node.matrix, node.matrix, readS16(view, p + 10) * Math.PI / 180);
                    mat4.rotateY(node.matrix, node.matrix, readS16(view, p + 12) * Math.PI / 180);
                    mat4.rotateZ(node.matrix, node.matrix, readS16(view, p + 14) * Math.PI / 180);
                    size = 16;
                } else if (layout === 0x10) {
                    mat4.translate(node.matrix, node.matrix, [readS16(view, p + 2), readS16(view, p + 4), readS16(view, p + 6)]);
                    size = 8;
                } else if (layout === 0x20) {
                    mat4.rotateX(node.matrix, node.matrix, readS16(view, p + 2) * Math.PI / 180);
                    mat4.rotateY(node.matrix, node.matrix, readS16(view, p + 4) * Math.PI / 180);
                    mat4.rotateZ(node.matrix, node.matrix, readS16(view, p + 6) * Math.PI / 180);
                    size = 8;
                } else {
                    mat4.rotateY(node.matrix, node.matrix, readS16(view, p + 2) * Math.PI / 180);
                    size = 4;
                }
                if (param & 0x80) { node.displayList = view.getUint32(p + size); size += 4; }
            } else if (op === 0x11 || op === 0x12 || op === 0x14) {
                if (op === 0x12) {
                    mat4.rotateX(node.matrix, node.matrix, readS16(view, p + 2) * Math.PI / 180);
                    mat4.rotateY(node.matrix, node.matrix, readS16(view, p + 4) * Math.PI / 180);
                    mat4.rotateZ(node.matrix, node.matrix, readS16(view, p + 6) * Math.PI / 180);
                } else {
                    mat4.translate(node.matrix, node.matrix, [readS16(view, p + 2), readS16(view, p + 4), readS16(view, p + 6)]);
                    node.billboard = op === 0x14;
                }
                size = 8;
                if (param & 0x80) { node.displayList = view.getUint32(p + 8); size = 12; }
            } else if (op === 0x13) {
                mat4.translate(node.matrix, node.matrix, [readS16(view, p + 2), readS16(view, p + 4), readS16(view, p + 6)]);
                node.displayList = view.getUint32(p + 8); size = 12;
            } else if (op === 0x15) { node.displayList = view.getUint32(p + 4); size = 8; }
            else if (op === 0x18) {
                // geo_offset_klepto_held_object overwrites the immediately
                // following translation/rotation node before it is traversed.
                if (view.getUint32(p + 4) === 0x802A45E4) overrideNextTranslation = [300, 300, 0];
                size = 8;
            }
            else if (op === 0x1C) size = 12;
            else if (op === 0x1D) {
                const encodedScale = view.getUint32(p + 4) / 0x10000;
                // Snufit's geo layout stores zero here because
                // geo_snufit_scale_body overwrites this node every frame.
                // Keep the node invertible; the renderer applies the callback's
                // actual runtime scale to the identified body display list.
                const scale = encodedScale === 0 ? 1 : encodedScale;
                mat4.scale(node.matrix, node.matrix, [scale, scale, scale]);
                size = 8;
                if (param & 0x80) { node.displayList = view.getUint32(p + 8); size = 12; }
            } else if (op === 0x1F) size = 16;
            else if (op > 0x20) break;
            p += size;
            if (p + 4 <= buffer.byteLength && view.getUint8(p) === 0x04) {
                p += 4;
                const childStart = (segment << 24) | p;
                node.children = parseList(childStart);
                // parseList stops after the matching close and does not expose its final offset;
                // walk forward over this balanced child stream to resume the parent's list.
                let depth = 1;
                while (p + 4 <= buffer.byteLength && depth > 0) {
                    const childOp = view.getUint8(p), childParam = view.getUint8(p + 1);
                    if (childOp === 0x04) depth++;
                    else if (childOp === 0x05) depth--;
                    let childSize = 4;
                    if (childOp === 0x00 || childOp === 0x02 || childOp === 0x0D || childOp === 0x0E || childOp === 0x15 || childOp === 0x16 || childOp === 0x18 || childOp === 0x19 || childOp === 0x1A || childOp === 0x1E) childSize = 8;
                    else if (childOp === 0x08 || childOp === 0x13 || childOp === 0x1C) childSize = 12;
                    else if (childOp === 0x0A) childSize = childParam !== 0 ? 12 : 8;
                    else if (childOp === 0x0F) childSize = 20;
                    else if (childOp === 0x10) { const l = childParam & 0x70; childSize = l === 0 ? 16 : l === 0x30 ? 4 : 8; if (childParam & 0x80) childSize += 4; }
                    else if (childOp === 0x11 || childOp === 0x12 || childOp === 0x14) childSize = (childParam & 0x80) ? 12 : 8;
                    else if (childOp === 0x1D) childSize = (childParam & 0x80) ? 12 : 8;
                    else if (childOp === 0x1F) childSize = 16;
                    p += childSize;
                }
            }
            nodes.push(node);
        }
        recursion.delete(startAddress);
        return nodes;
    };

    const parts: GeoPart[] = [];
    let animatedPartIndex = 0;
    const flatten = (nodes: GeoNode[], parent: mat4, billboard: boolean, animated: boolean): void => {
        for (const node of nodes) {
            const matrix = mat4.mul(mat4.create(), parent, node.matrix);
            if (node.animated && animationPose !== undefined) {
                if (animatedPartIndex === 0) mat4.translate(matrix, matrix, animationPose.rootTranslation);
                const rotation = animationPose.rotations[animatedPartIndex++];
                if (rotation !== undefined) {
                    mat4.rotateZ(matrix, matrix, rotation[2]);
                    mat4.rotateY(matrix, matrix, rotation[1]);
                    mat4.rotateX(matrix, matrix, rotation[0]);
                }
            }
            const isBillboard = billboard || node.billboard;
            const isAnimated = animated || node.animated;
            if (node.displayList !== 0) parts.push({ displayList: node.displayList, matrix, billboard: isBillboard, layer: node.layer, animated: isAnimated });
            const selectedSwitchCase = switchFunctionAddress === undefined || node.switchFunction === switchFunctionAddress ? switchCaseIndex : 0;
            flatten(node.switchCase ? node.children.slice(selectedSwitchCase, selectedSwitchCase + 1) : node.children, matrix, isBillboard, isAnimated);
        }
    };
    flatten(parseList(address), mat4.create(), false, false);
    return parts;
}
