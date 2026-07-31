import { DeviceProgram } from '../Program.js';
import { GfxShaderLibrary } from '../gfx/helpers/GfxShaderLibrary.js';
import { createBufferFromData } from '../gfx/helpers/BufferHelpers.js';
import { fillMatrix4x4, fillVec4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { GfxBlendFactor, GfxBlendMode, GfxBuffer, GfxBufferFrequencyHint, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFormat, GfxInputLayout, GfxMipFilterMode, GfxProgram, GfxSampler, GfxTexFilterMode, GfxTexture, GfxVertexBufferDescriptor, GfxVertexBufferFrequency, GfxWrapMode, makeTextureDescriptor2D } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { GfxRendererLayer, GfxRenderInst, GfxRenderInstManager, makeSortKey, setSortKeyDepth } from '../gfx/render/GfxRenderInstManager.js';
import { DecodedTexture, TerrainMesh } from './bin.js';
import { mat4 } from 'gl-matrix';
import { TextureMapping } from '../TextureHolder.js';
import { AABB, Frustum } from '../Geometry.js';
import { setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers.js';
import { computeViewSpaceDepthFromWorldSpaceAABB } from '../Camera.js';

export class TerrainProgram extends DeviceProgram {
    public static ub_SceneParams = 0;
    public static ub_MaterialParams = 1;
    public override both = `
precision highp float;
${GfxShaderLibrary.MatrixLibrary}
layout(std140) uniform ub_SceneParams { Mat4x4 u_ClipFromWorld; vec4 u_ViewportTime; };
layout(std140) uniform ub_MaterialParams { vec4 u_AlphaTest; };
varying vec4 v_Color;
varying vec2 v_TexCoord;
varying vec2 v_TexCoord2;
layout(binding=0) uniform sampler2D u_Texture;
#ifdef VERT
layout(location=0) attribute vec3 a_Position;
layout(location=1) attribute vec3 a_Normal;
layout(location=2) attribute vec4 a_Color;
layout(location=3) attribute vec2 a_TexCoord;
layout(location=4) attribute vec2 a_TexCoord2;
void mainVS() {
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(a_Position, 1.0);
    v_Color = a_Color;
    v_TexCoord = a_TexCoord;
    v_TexCoord2 = a_TexCoord2;
}
#endif
#ifdef FRAG
void mainPS() {
    gl_FragColor = texture(SAMPLER_2D(u_Texture), v_TexCoord) * v_Color;
    // Host texture/vertex alpha is normalized from the PS2's 0..0x80 range.
    // Convert the combined result back to the value consumed by GS TEST.
    int alpha = int(clamp(floor(gl_FragColor.a * 128.0 + 0.5), 0.0, 255.0));
    int atst = int(u_AlphaTest.x);
    int aref = int(u_AlphaTest.y);
    bool pass = atst == 1 ||
        (atst == 2 && alpha <  aref) ||
        (atst == 3 && alpha <= aref) ||
        (atst == 4 && alpha == aref) ||
        (atst == 5 && alpha >= aref) ||
        (atst == 6 && alpha >  aref) ||
        (atst == 7 && alpha != aref);
    // AFAIL=KEEP suppresses both framebuffer and depth-buffer updates.
    // Other AFAIL modes require separate color/depth write masks.
    if (!pass && int(u_AlphaTest.z) == 0)
        discard;
}
#endif`;
}

export class TerrainGeometry {
    private buffer: GfxBuffer;
    private descriptor: GfxVertexBufferDescriptor[];
    private mapping: TextureMapping[];
    private bounds = new AABB();
    public vertexCount: number;
    public isProp: boolean;
    constructor(device: GfxDevice, mesh: TerrainMesh, textures: TerrainTextures) {
        this.buffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, mesh.vertices.buffer);
        this.descriptor = [{ buffer: this.buffer }];
        this.mapping = [textures.getMapping(mesh.textureName, mesh.clampS, mesh.clampT)];
        const texture = textures.getTexture(mesh.textureName);
        this.alphaTest = texture?.alphaTest ?? 1;
        this.alphaReference = texture?.alphaReference ?? 0;
        this.alphaFail = texture?.alphaFail ?? 0;
        if (mesh.isWater) {
            this.mapping.push(textures.getMapping(mesh.secondaryTextureName, mesh.secondaryClampS, mesh.secondaryClampT));
        }
        this.isProp = mesh.isProp;
        this.isLayer1 = mesh.isLayer1;
        this.isSpecialLayer = mesh.isSpecialLayer;
        this.isTranslucent = mesh.isTranslucent;
        this.isWater = mesh.isWater;
        this.gsAlpha = mesh.gsAlpha;
        this.gsAlphaFix = mesh.gsAlphaFix;
        this.vertexCount = mesh.vertices.length / 14;
        for (let i = 0; i < mesh.vertices.length; i += 14) {
            this.bounds.min[0] = Math.min(this.bounds.min[0], mesh.vertices[i]);
            this.bounds.min[1] = Math.min(this.bounds.min[1], mesh.vertices[i + 1]);
            this.bounds.min[2] = Math.min(this.bounds.min[2], mesh.vertices[i + 2]);
            this.bounds.max[0] = Math.max(this.bounds.max[0], mesh.vertices[i]);
            this.bounds.max[1] = Math.max(this.bounds.max[1], mesh.vertices[i + 1]);
            this.bounds.max[2] = Math.max(this.bounds.max[2], mesh.vertices[i + 2]);
        }
    }
    public isWater: boolean;
    public isLayer1: boolean;
    public isSpecialLayer: boolean;
    private isTranslucent: boolean;
    private gsAlpha: number;
    private gsAlphaFix: number;
    private alphaTest: number;
    private alphaReference: number;
    private alphaFail: number;
    public prepareToRender(manager: GfxRenderInstManager, pipeline: TerrainPipeline, frustum: Frustum, viewMatrix: mat4): void {
        if (!frustum.contains(this.bounds))
            return;
        const inst = manager.newRenderInst();
        inst.setVertexInput(pipeline.inputLayout, this.descriptor, null);
        // modelDisp always emits the ordinary SRF pass first. The 0x2200
        // surfaces are redrawn later on layers 9 and 15; a framebuffer-effect
        // shader must never replace this base draw.
        inst.setGfxProgram(pipeline.terrainProgram);
        inst.setBindingLayouts([{ numUniformBuffers: 2, numSamplers: this.mapping.length }]);
        inst.setSamplerBindingsFromTextureMappings(this.mapping);
        const materialOffs = inst.allocateUniformBuffer(TerrainProgram.ub_MaterialParams, 4);
        fillVec4(inst.mapUniformBufferF32(TerrainProgram.ub_MaterialParams), materialOffs,
            this.alphaTest, this.alphaReference, this.alphaFail, 0);
        // TODO(SotC): decode and retain the per-strip bypass word read by the
        // VU from -5(vi4). SRF 0x10000 is already retained, but enabling GPU
        // culling from that flag alone would incorrectly reject exempt strips.
        // Blended layers are independently sorted at their original
        // draw-descriptor granularity. They must not write transparent texels
        // into depth before geometry behind them is submitted.
        inst.setMegaStateFlags({ cullMode: GfxCullMode.None, depthWrite: !this.isTranslucent });
        inst.sortKey = makeSortKey(this.isTranslucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE);
        if (this.isTranslucent) {
            const depth = computeViewSpaceDepthFromWorldSpaceAABB(viewMatrix, this.bounds);
            inst.sortKey = setSortKeyDepth(inst.sortKey, depth);
        }
        // GS ALPHA is (A-B)*C+D. These are every authored equation found in
        // the extracted world SRFs and map directly to fixed-function factors.
        if (this.gsAlpha === 0x44) {
            setAttachmentStateSimple(inst.getMegaStateFlags(), {
                blendMode: GfxBlendMode.Add,
                blendSrcFactor: GfxBlendFactor.SrcAlpha,
                blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
            });
        } else if (this.gsAlpha === 0x48) {
            setAttachmentStateSimple(inst.getMegaStateFlags(), {
                blendMode: GfxBlendMode.Add,
                blendSrcFactor: GfxBlendFactor.SrcAlpha,
                blendDstFactor: GfxBlendFactor.One,
            });
        } else if (this.gsAlpha === 0x42) {
            setAttachmentStateSimple(inst.getMegaStateFlags(), {
                blendMode: GfxBlendMode.Add,
                blendSrcFactor: GfxBlendFactor.SrcAlpha,
                blendDstFactor: GfxBlendFactor.Zero,
            });
        } else {
            console.warn(`[SotC] unsupported GS ALPHA 0x${this.gsAlpha.toString(16)} FIX=${this.gsAlphaFix}`);
        }
        inst.setDrawCount(this.vertexCount);
        manager.submitRenderInst(inst);
    }
    public destroy(device: GfxDevice): void { device.destroyBuffer(this.buffer); }
}

export class TerrainTextures {
    private textures = new Map<string, GfxTexture>();
    private decoded = new Map<string, DecodedTexture>();
    private fallback: GfxTexture;
    private samplers = new Map<string, GfxSampler>();
    constructor(device: GfxDevice, cache: GfxRenderCache, decoded: DecodedTexture[]) {
        for (const clampS of [false, true]) for (const clampT of [false, true]) {
            this.samplers.set(`${clampS}|${clampT}`, cache.createSampler({
                wrapS: clampS ? GfxWrapMode.Clamp : GfxWrapMode.Repeat,
                wrapT: clampT ? GfxWrapMode.Clamp : GfxWrapMode.Repeat,
                minFilter: GfxTexFilterMode.Bilinear, magFilter: GfxTexFilterMode.Bilinear,
                mipFilter: GfxMipFilterMode.Nearest, minLOD: 0, maxLOD: 0,
            }));
        }
        this.fallback = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, 1, 1, 1));
        device.uploadTextureData(this.fallback, 0, [new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF])]);
        for (const texture of decoded) {
            this.addTexture(device, texture);
        }
    }
    private addTexture(device: GfxDevice, texture: DecodedTexture): void {
        if (this.textures.has(texture.name))
            return;
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, texture.width, texture.height, 1));
        device.setResourceName(gfxTexture, texture.name);
        device.uploadTextureData(gfxTexture, 0, [texture.pixels]);
        this.textures.set(texture.name, gfxTexture);
        this.decoded.set(texture.name, texture);
    }
    public addTextures(device: GfxDevice, textures: DecodedTexture[]): void {
        for (const texture of textures)
            this.addTexture(device, texture);
    }
    public getTexture(name: string | null): DecodedTexture | null {
        return name === null ? null : this.decoded.get(name) ?? null;
    }
    public getMapping(name: string | null, clampS: boolean, clampT: boolean): TextureMapping {
        const mapping = new TextureMapping();
        mapping.gfxTexture = name === null ? this.fallback : this.textures.get(name) ?? this.fallback;
        mapping.gfxSampler = this.samplers.get(`${clampS}|${clampT}`)!;
        return mapping;
    }
    public destroy(device: GfxDevice): void {
        device.destroyTexture(this.fallback);
        for (const texture of this.textures.values()) device.destroyTexture(texture);
    }
}

export interface TerrainPipeline {
    terrainProgram: GfxProgram;
    inputLayout: GfxInputLayout;
}

export function makeTerrainPipeline(cache: GfxRenderCache): TerrainPipeline {
    const terrainProgram = cache.createProgram(new TerrainProgram());
    const inputLayout = cache.createInputLayout({
        vertexAttributeDescriptors: [
            { location: 0, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB },
            { location: 1, bufferIndex: 0, bufferByteOffset: 12, format: GfxFormat.F32_RGB },
            { location: 2, bufferIndex: 0, bufferByteOffset: 24, format: GfxFormat.F32_RGBA },
            { location: 3, bufferIndex: 0, bufferByteOffset: 40, format: GfxFormat.F32_RG },
            { location: 4, bufferIndex: 0, bufferByteOffset: 48, format: GfxFormat.F32_RG },
        ],
        vertexBufferDescriptors: [{ byteStride: 56, frequency: GfxVertexBufferFrequency.PerVertex }],
        indexBufferFormat: null,
    });
    return { terrainProgram, inputLayout };
}

export function fillSceneParams(template: GfxRenderInst, clipFromWorld: mat4, width: number, height: number, time: number): void {
    // Establish the inherited uniform-buffer binding before allocating it.
    // Individual draws replace only the sampler count below.
    template.setBindingLayouts([{ numUniformBuffers: 2, numSamplers: 3 }]);
    const offs = template.allocateUniformBuffer(TerrainProgram.ub_SceneParams, 20);
    const d = template.mapUniformBufferF32(TerrainProgram.ub_SceneParams);
    fillMatrix4x4(d, offs, clipFromWorld);
    fillVec4(d, offs + 16, width, height, time * 0.001);
}
