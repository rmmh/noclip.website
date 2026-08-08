import { mat4, ReadonlyVec3, vec3, vec4 } from 'gl-matrix';
import type { Camera } from '../../Camera.js';
import type { ViewerRenderInput } from '../../viewer.js';
import { PeekZManager, PeekZResult } from './DepthPeek.js';
import { GfxClipSpaceNearZ, GfxDevice } from '../platform/GfxPlatform.js';
import { GfxRenderCache } from '../render/GfxRenderCache.js';
import { GfxrGraphBuilder, GfxrRenderTargetID } from '../render/GfxRenderGraph.js';
import { GfxRenderInstManager } from '../render/GfxRenderInstManager.js';

interface DepthSampleRequest {
    inverseClipFromWorld: mat4 | null;
    ndcX: number;
    ndcY: number;
    clipSpaceNearZ: GfxClipSpaceNearZ;
}

export class ViewerDepthPicker {
    private peekZ = new PeekZManager(1);
    private renderInstManager: GfxRenderInstManager;
    private input: ViewerRenderInput | null = null;
    private pending: PeekZResult | null = null;
    private hit = vec3.create();
    private hasHit = false;
    private requested = false;
    private ready = false;

    constructor(device: GfxDevice, private canvas: HTMLCanvasElement) {
        this.renderInstManager = new GfxRenderInstManager(new GfxRenderCache(device));
    }

    public prepare(device: GfxDevice, input: ViewerRenderInput): void {
        this.input = input;
        this.peekZ.peekData(device);
        if (this.pending !== null && this.pending.value !== null) {
            this.resolve(this.pending, input.camera);
            this.pending = null;
        }
        input.camera.raycast = this.raycast;
    }

    public pushPasses = (builder: GfxrGraphBuilder, depthTargetID: GfxrRenderTargetID): void => {
        if (!this.requested || this.pending !== null || this.input === null)
            return;
        const input = this.input;
        const mouseX = input.mouseLocation.mouseX, mouseY = input.mouseLocation.mouseY;
        if (mouseX < 0 || mouseY < 0)
            return;
        const rect = this.canvas.getBoundingClientRect();
        const x = mouseX / window.devicePixelRatio - rect.left;
        const y = mouseY / window.devicePixelRatio - rect.top;
        if (x < 0 || y < 0 || x >= rect.width || y >= rect.height)
            return;
        const ndcX = x / rect.width * 2 - 1;
        const ndcY = 1 - y / rect.height * 2;
        this.peekZ.beginFrame(this.renderInstManager.gfxRenderCache.device);
        this.requested = false;
        this.pending = new PeekZResult();
        this.peekZ.newData(this.pending, ndcX, ndcY, {
            inverseClipFromWorld: null,
            ndcX,
            ndcY,
            clipSpaceNearZ: input.camera.clipSpaceNearZ,
        } satisfies DepthSampleRequest, (userData) => {
            const request = userData as DepthSampleRequest;
            request.inverseClipFromWorld = mat4.invert(mat4.create(), input.camera.clipFromWorldMatrix);
            request.clipSpaceNearZ = input.camera.clipSpaceNearZ;
        });
        this.peekZ.pushPasses(this.renderInstManager, builder, depthTargetID);
    };

    private resolve(result: PeekZResult, camera: Camera): void {
        this.hasHit = false;
        this.ready = true;
        const depth = result.value!;
        if (depth <= 0.000001)
            return;
        const request = result.userData as DepthSampleRequest;
        const clipZ = request.clipSpaceNearZ === GfxClipSpaceNearZ.NegativeOne ? depth * 2 - 1 : depth;
        if (request.inverseClipFromWorld === null)
            return;
        const p = vec4.transformMat4(vec4.create(), vec4.fromValues(request.ndcX, request.ndcY, clipZ, 1), request.inverseClipFromWorld);
        if (Math.abs(p[3]) <= 0.000001)
            return;
        vec3.set(this.hit, p[0] / p[3], p[1] / p[3], p[2] / p[3]);
        this.hasHit = true;
        camera.raycast = this.raycast;
    }

    private raycast = (out: vec3, origin: ReadonlyVec3, direction: ReadonlyVec3): boolean | null => {
        if (this.pending !== null || this.requested)
            return null;
        if (this.ready) {
            this.ready = false;
        } else {
            this.hasHit = false;
            this.requested = true;
            return null;
        }
        if (!this.hasHit)
            return false;
        const toHit = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), this.hit, origin));
        if (vec3.dot(toHit, direction) < 0.995)
            return false;
        vec3.copy(out, this.hit);
        return true;
    };

    public destroy(device: GfxDevice): void {
        this.peekZ.destroy(device);
        this.renderInstManager.gfxRenderCache.destroy();
    }
}
