import { mat4, vec3 } from 'gl-matrix';
import { PokemonAnimation, PokemonGeoNode } from './archive.js';
import { buildLocalMatrix, sampleAnimationTrack } from './animation.js';

export interface SelectedPokemonAnimation {
    animation: PokemonAnimation;
    index: number;
    frame: number;
    elapsed: number;
}

export class PokemonModelPose {
    public readonly geoChildren: number[][];
    public readonly geoRoots: number[] = [];
    public readonly nodeMatrices: mat4[];
    public readonly nodeJointMatrices: mat4[];

    constructor(private dataView: DataView, private geoNodes: PokemonGeoNode[], private modelMatrix: mat4) {
        this.geoChildren = geoNodes.map(() => []);
        this.nodeMatrices = geoNodes.map(() => mat4.create());
        this.nodeJointMatrices = geoNodes.map(() => mat4.create());
        for (let i = 0; i < geoNodes.length; i++) {
            if (geoNodes[i].Parent < 0) this.geoRoots.push(i);
            else this.geoChildren[geoNodes[i].Parent].push(i);
        }
    }

    public update(selected: SelectedPokemonAnimation | null): void {
        const walk = (index: number, parentMatrix: mat4, parentJointMatrix: mat4, parentScale: vec3): void => {
            const node = this.geoNodes[index];
            const translation = [...node.Translation];
            const rotation = [...node.Rotation];
            const scale = [...node.Scale];
            if (selected !== null && node.AnimationChannel >= 0) {
                const firstTrack = node.AnimationChannel * 3;
                if (firstTrack + 2 < selected.animation.Tracks.length) {
                    for (let axis = 0; axis < 3; axis++) {
                        const sampled = sampleAnimationTrack(this.dataView, selected.animation, selected.animation.Tracks[firstTrack + axis], selected.frame);
                        scale[axis] = sampled[0]; rotation[axis] = sampled[1]; translation[axis] = sampled[2];
                    }
                }
            }
            const matrix = this.nodeMatrices[index];
            const jointMatrix = this.nodeJointMatrices[index];
            const cumulativeScale = vec3.clone(parentScale);
            if (node.Command === 0x1D && node.TransformMode === 0) {
                // GraphNode_RenderAnimatedTransform keeps the rotation/translation joint matrix
                // unscaled, while push_graph_node_scale maintains scale separately.
                // Children inherit that joint matrix and the cumulative scale;
                // only the matrix submitted for drawing receives the scale.
                const scaledTranslation = [
                    translation[0] * parentScale[0],
                    translation[1] * parentScale[1],
                    translation[2] * parentScale[2],
                ];
                vec3.set(cumulativeScale,
                    parentScale[0] * scale[0], parentScale[1] * scale[1], parentScale[2] * scale[2]);
                buildLocalMatrix(jointMatrix, scaledTranslation, rotation, [1, 1, 1]);
                mat4.mul(jointMatrix, parentJointMatrix, jointMatrix);
                mat4.copy(matrix, jointMatrix);
                mat4.scale(matrix, matrix, cumulativeScale);
            } else if (node.Command === 0x1D || node.Command === 0x1B || node.Command === 0x1C ||
                node.Command === 0x20 || node.Command === 0x21) {
                buildLocalMatrix(matrix, translation, rotation, scale);
                mat4.mul(matrix, parentMatrix, matrix);
                mat4.copy(jointMatrix, matrix);
                vec3.set(cumulativeScale, 1, 1, 1);
            } else {
                mat4.copy(matrix, parentMatrix);
                mat4.copy(jointMatrix, parentJointMatrix);
            }
            for (const child of this.geoChildren[index]) walk(child, matrix, jointMatrix, cumulativeScale);
        };
        const identityScale = vec3.fromValues(1, 1, 1);
        for (const root of this.geoRoots) walk(root, this.modelMatrix, this.modelMatrix, identityScale);
    }

    /** Position recorded by graph command 0x24 / GraphNode_RenderAttachment. */
    public getAttachmentPosition(attachmentID: number, dst: vec3): boolean {
        for (let i = 0; i < this.geoNodes.length; i++) {
            if (this.geoNodes[i].AttachmentID !== attachmentID) continue;
            mat4.getTranslation(dst, this.nodeJointMatrices[i]);
            return true;
        }
        return false;
    }
}
