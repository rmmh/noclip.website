import type { Texture } from '../src/Common/N64/RDP.js';
import type { SceneGfx } from '../src/viewer.js';
import { RSP_Geometry } from '../src/DonkeyKong64/f3dex2.js';
import type { DrawCall } from '../src/DonkeyKong64/f3dex2.js';
import type { GeometryData, GeometryRenderer } from '../src/DonkeyKong64/render.js';

const textEncoder = new TextEncoder();
const scratch = new DataView(new ArrayBuffer(8));
export class RDPRegressionHash {
    private value0 = 0x811C9DC5;
    private value1 = 0x9E3779B9;

    private bytes(data: Uint8Array): void {
        for (let i = 0; i < data.byteLength; i++) {
            const byte = data[i];
            this.value0 = Math.imul(this.value0 ^ byte, 0x01000193);
            this.value1 = Math.imul(this.value1 ^ byte, 0x85EBCA6B);
        }
    }

    public byteArray(data: Uint8Array): void {
        this.u32(data.byteLength);
        this.bytes(data);
    }

    public string(value: string): void {
        const bytes = textEncoder.encode(value);
        this.u32(bytes.byteLength);
        this.bytes(bytes);
    }

    public bool(value: boolean): void {
        this.u32(value ? 1 : 0);
    }

    public u32(value: number): void {
        scratch.setUint32(0, value >>> 0, true);
        this.bytes(new Uint8Array(scratch.buffer, 0, 4));
    }

    public f32(value: number): void {
        scratch.setFloat32(0, value, true);
        this.bytes(new Uint8Array(scratch.buffer, 0, 4));
    }

    public f32Array(values: ArrayLike<number>): void {
        this.u32(values.length);
        for (let i = 0; i < values.length; i++)
            this.f32(values[i]);
    }

    public u32Array(values: ArrayLike<number>): void {
        this.u32(values.length);
        for (let i = 0; i < values.length; i++)
            this.u32(values[i]);
    }

    public finish(): string {
        return (this.value0 >>> 0).toString(16).padStart(8, '0')
            + (this.value1 >>> 0).toString(16).padStart(8, '0');
    }
}

function hashCombine(hash: RDPRegressionHash, drawCall: DrawCall): void {
    for (const pass of [
        drawCall.DP_Combine.c0, drawCall.DP_Combine.a0,
        drawCall.DP_Combine.c1, drawCall.DP_Combine.a1,
    ]) {
        hash.u32(pass.a);
        hash.u32(pass.b);
        hash.u32(pass.c);
        hash.u32(pass.d);
    }
}

function hashDrawCall(hash: RDPRegressionHash, drawCall: DrawCall, tick: number): void {
    hash.u32(drawCall.SP_GeometryMode);
    hash.bool(drawCall.SP_TextureState.on);
    hash.u32(drawCall.SP_TextureState.tile);
    hash.u32(drawCall.SP_TextureState.level);
    hash.f32(drawCall.SP_TextureState.s);
    hash.f32(drawCall.SP_TextureState.t);
    hash.u32(drawCall.DP_OtherModeH);
    hash.u32(drawCall.DP_OtherModeL);
    hashCombine(hash, drawCall);
    hash.f32Array(drawCall.DP_PrimColor);
    hash.f32Array(drawCall.DP_EnvColor);
    hash.f32(drawCall.DP_PrimLOD);
    hash.bool((drawCall.SP_GeometryMode & RSP_Geometry.G_SHADE) !== 0);
    hash.u32(drawCall.firstIndex);
    hash.u32(drawCall.indexCount);

    hash.u32(drawCall.textureIndices.length);
    for (let i = 0; i < drawCall.textureIndices.length; i++) {
        const binding = drawCall.textureBindings[i];
        const animation = binding?.animation;
        const frameDuration = Math.max(animation?.frameDuration ?? 1, 1);
        const frame = animation === undefined
            ? 0
            : (Math.floor(tick / frameDuration) + animation.frameOffset) % animation.textureIndices.length;
        hash.u32(animation?.textureIndices[frame] ?? drawCall.textureIndices[i]);
        hash.u32(binding?.scrollSpeed ?? 0);
        hash.u32(frame);
        hash.u32(frameDuration);
        hash.u32(animation?.crossfadeGroup ?? 0xFFFFFFFF);
    }
}

export function hashTexture(hash: RDPRegressionHash, texture: Texture): void {
    hash.u32(texture.dramAddr);
    hash.u32(texture.dramPalAddr);
    hash.u32(texture.width);
    hash.u32(texture.height);
    hash.u32(texture.tile.fmt);
    hash.u32(texture.tile.siz);
    hash.u32(texture.tile.line);
    hash.u32(texture.tile.tmem);
    hash.u32(texture.tile.palette);
    hash.u32(texture.tile.cmt);
    hash.u32(texture.tile.maskt);
    hash.u32(texture.tile.shiftt);
    hash.u32(texture.tile.cms);
    hash.u32(texture.tile.masks);
    hash.u32(texture.tile.shifts);
    hash.u32(texture.tile.uls);
    hash.u32(texture.tile.ult);
    hash.u32(texture.tile.lrs);
    hash.u32(texture.tile.lrt);
    // Texture pixels are already canonical RGBA8 output from the RDP texture decoder.
    hash.byteArray(texture.pixels);
}

export function hashMeshData(hash: RDPRegressionHash, geoData: GeometryData, tick: number): void {
    const drawCalls = geoData.geo.rspOutput?.drawCalls ?? [];
    hash.u32(drawCalls.length);
    for (const drawCall of drawCalls) {
        hashDrawCall(hash, drawCall, tick);
        hash.u32Array(geoData.geo.sharedOutput.indices.slice(
            drawCall.firstIndex, drawCall.firstIndex + drawCall.indexCount,
        ));
    }
    hash.f32Array(geoData.renderData.vertexBufferData);
    const boneMatrices = geoData.geo.actorAnimation?.pose.boneMatrices ?? [];
    hash.u32(boneMatrices.length);
    for (const boneMatrix of boneMatrices)
        hash.f32Array(boneMatrix);
}

export function hashMeshRenderer(hash: RDPRegressionHash, geoRenderer: GeometryRenderer): void {
    const geoData = (geoRenderer as unknown as { geometryData: GeometryData }).geometryData;
    hash.u32(geoRenderer.renderLayer);
    hash.f32Array(geoRenderer.modelMatrix);
    hash.u32(geoData.renderData.indexStart);
}

export interface RegressionRenderer extends SceneGfx {
    geoDatas: GeometryData[];
    geoRenderers: GeometryRenderer[];
}

export function isDK64Renderer(scene: SceneGfx): scene is RegressionRenderer {
    const candidate = scene as Partial<RegressionRenderer>;
    return Array.isArray(candidate.geoDatas) && Array.isArray(candidate.geoRenderers);
}
