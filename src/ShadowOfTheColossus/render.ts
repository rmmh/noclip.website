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
    if (u_AlphaTest.z < 0.0)
        gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0);
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
    // u_AlphaTest.w selects the passing or failing half of GS TEST. AFAIL
    // modes with different framebuffer/depth masks are emitted as a second
    // draw with the appropriate fixed-function write state.
    int alphaHalf = int(u_AlphaTest.w);
    if ((alphaHalf == 0 && !pass) || (alphaHalf == 1 && pass))
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
    public sourceName: string;
    public surfaceName: string;
    public textureName: string | null;
    private textureDebug: Record<string, number> | null = null;
    constructor(device: GfxDevice, mesh: TerrainMesh, textures: TerrainTextures) {
        this.buffer = createBufferFromData(device, GfxBufferUsage.Vertex, GfxBufferFrequencyHint.Static, mesh.vertices.buffer);
        this.descriptor = [{ buffer: this.buffer }];
        this.mapping = [textures.getMapping(mesh.textureName, mesh.clampS, mesh.clampT)];
        const texture = textures.getTexture(mesh.textureName);
        if (texture !== null) {
            let alphaMin = 0xFF, alphaMax = 0, alphaPassing = 0;
            for (let i = 3; i < texture.pixels.length; i += 4) {
                const alpha = texture.pixels[i];
                alphaMin = Math.min(alphaMin, alpha);
                alphaMax = Math.max(alphaMax, alpha);
                if (texture.alphaTest === 1 ||
                    (texture.alphaTest === 2 && alpha < texture.alphaReference) ||
                    (texture.alphaTest === 3 && alpha <= texture.alphaReference) ||
                    (texture.alphaTest === 4 && alpha === texture.alphaReference) ||
                    (texture.alphaTest === 5 && alpha >= texture.alphaReference) ||
                    (texture.alphaTest === 6 && alpha > texture.alphaReference) ||
                    (texture.alphaTest === 7 && alpha !== texture.alphaReference))
                    alphaPassing++;
            }
            this.textureDebug = {
                width: texture.width,
                height: texture.height,
                alphaMin,
                alphaMax,
                alphaPassing,
                texels: texture.pixels.length / 4,
            };
        }
        this.alphaTest = texture?.alphaTest ?? 1;
        this.alphaReference = texture?.alphaReference ?? 0;
        this.alphaFail = texture?.alphaFail ?? 0;
        if (mesh.isWater) {
            this.mapping.push(textures.getMapping(mesh.secondaryTextureName, mesh.secondaryClampS, mesh.secondaryClampT));
        }
        this.isProp = mesh.isProp;
        this.sourceName = mesh.sourceName;
        this.surfaceName = mesh.surfaceName;
        this.textureName = mesh.textureName;
        this.isLayer1 = mesh.isLayer1;
        this.isSpecialLayer = mesh.isSpecialLayer;
        this.isTranslucent = mesh.isTranslucent;
        this.alphaBlend = mesh.alphaBlend;
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
    private alphaBlend: boolean;
    private gsAlpha: number;
    private gsAlphaFix: number;
    private alphaTest: number;
    private alphaReference: number;
    private alphaFail: number;
    public isVisible(frustum: Frustum): boolean { return frustum.contains(this.bounds); }
    public debugDraw(clipFromWorld: mat4): Record<string, unknown> {
        const ndcMin = [Infinity, Infinity, Infinity];
        const ndcMax = [-Infinity, -Infinity, -Infinity];
        let frontCorners = 0;
        for (let corner = 0; corner < 8; corner++) {
            const x = (corner & 1) !== 0 ? this.bounds.max[0] : this.bounds.min[0];
            const y = (corner & 2) !== 0 ? this.bounds.max[1] : this.bounds.min[1];
            const z = (corner & 4) !== 0 ? this.bounds.max[2] : this.bounds.min[2];
            const cx = clipFromWorld[0] * x + clipFromWorld[4] * y + clipFromWorld[8] * z + clipFromWorld[12];
            const cy = clipFromWorld[1] * x + clipFromWorld[5] * y + clipFromWorld[9] * z + clipFromWorld[13];
            const cz = clipFromWorld[2] * x + clipFromWorld[6] * y + clipFromWorld[10] * z + clipFromWorld[14];
            const cw = clipFromWorld[3] * x + clipFromWorld[7] * y + clipFromWorld[11] * z + clipFromWorld[15];
            if (cw <= 0)
                continue;
            frontCorners++;
            const values = [cx / cw, cy / cw, cz / cw];
            for (let axis = 0; axis < 3; axis++) {
                ndcMin[axis] = Math.min(ndcMin[axis], values[axis]);
                ndcMax[axis] = Math.max(ndcMax[axis], values[axis]);
            }
        }
        const round = (value: number): number => Math.round(value * 1000) / 1000;
        return {
            source: this.sourceName,
            surface: this.surfaceName,
            texture: this.textureName,
            bounds: { min: [...this.bounds.min], max: [...this.bounds.max] },
            ndc: frontCorners === 0 ? null : {
                min: ndcMin.map(round), max: ndcMax.map(round), frontCorners,
            },
            layer1: this.isLayer1,
            specialLayer: this.isSpecialLayer,
            translucent: this.isTranslucent,
            alphaBlend: this.alphaBlend,
            depthWrite: !this.isTranslucent,
            alphaTest: this.alphaTest,
            alphaReference: this.alphaReference,
            alphaFail: this.alphaFail,
            texturePixels: this.textureDebug,
            gsAlpha: `0x${this.gsAlpha.toString(16)}`,
        };
    }
    public prepareToRender(manager: GfxRenderInstManager, pipeline: TerrainPipeline, frustum: Frustum, viewMatrix: mat4, debugHighlight = false): void {
        if (!this.isVisible(frustum))
            return;
        const submit = (alphaHalf: number, depthWrite: boolean): void => {
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
                this.alphaTest, this.alphaReference, debugHighlight ? -1 : this.alphaFail, alphaHalf);
            // TODO(SotC): decode and retain the per-strip bypass word read by the
            // VU from -5(vi4). SRF 0x10000 is already retained, but enabling GPU
            // culling from that flag alone would incorrectly reject exempt strips.
            inst.setMegaStateFlags({ cullMode: GfxCullMode.None, depthWrite: depthWrite && !this.isTranslucent });
            inst.sortKey = makeSortKey(this.isTranslucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE);
            if (this.isTranslucent) {
                const depth = computeViewSpaceDepthFromWorldSpaceAABB(viewMatrix, this.bounds);
                inst.sortKey = setSortKeyDepth(inst.sortKey, depth);
            }
            // GS ALPHA is (A-B)*C+D. These are every authored equation found in
            // the extracted world SRFs and map directly to fixed-function factors.
            if (!this.alphaBlend) {
                // GS ALPHA state is persistent, but has no effect unless the
                // primitive's ABE bit is enabled by the authored surface.
            } else if (this.gsAlpha === 0x44) {
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
        };
        // AFAIL=FB_ONLY preserves the blended framebuffer result for failed
        // alpha texels but suppresses their depth write. This is the common
        // foliage-card mode (ATST >= 0x40) used by tree cards. Emit this half
        // first: GS applies the pass/fail write masks while rasterizing one
        // primitive stream, whereas our split draws would otherwise let the
        // soft failure half overwrite passing pixels from overlapping cards.
        if (this.alphaFail === 1 && this.alphaTest !== 1)
            submit(1, false);
        submit(0, true);
    }
    public destroy(device: GfxDevice): void { device.destroyBuffer(this.buffer); }
}

export class TerrainTextures {
    private textures = new Map<string, GfxTexture>();
    private decoded = new Map<string, DecodedTexture>();
    private fallback: GfxTexture;
    private samplers = new Map<string, GfxSampler>();
    constructor(device: GfxDevice, cache: GfxRenderCache, decoded: DecodedTexture[]) {
        for (const clampS of [false, true]) for (const clampT of [false, true])
            for (let magFilter = 0; magFilter <= 1; magFilter++) for (let minFilter = 0; minFilter <= 5; minFilter++) {
                const usesMipmaps = minFilter >= 2;
                this.samplers.set(`${clampS}|${clampT}|${magFilter}|${minFilter}`, cache.createSampler({
                    wrapS: clampS ? GfxWrapMode.Clamp : GfxWrapMode.Repeat,
                    wrapT: clampT ? GfxWrapMode.Clamp : GfxWrapMode.Repeat,
                    // GS MMIN 0/2/3 use nearest texels; 1/4/5 use linear texels.
                    minFilter: [0, 2, 3].includes(minFilter) ? GfxTexFilterMode.Point : GfxTexFilterMode.Bilinear,
                    magFilter: magFilter === 0 ? GfxTexFilterMode.Point : GfxTexFilterMode.Bilinear,
                    // GS MMIN 3/5 interpolate between mip levels. 2/4 select
                    // the nearest level, while 0/1 disable mipmapping.
                    mipFilter: [3, 5].includes(minFilter) ? GfxMipFilterMode.Linear : GfxMipFilterMode.Nearest,
                    minLOD: 0, maxLOD: usesMipmaps ? 100 : 0,
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
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(
            GfxFormat.U8_RGBA_NORM, texture.width, texture.height, texture.levels.length,
        ));
        device.setResourceName(gfxTexture, texture.name);
        device.uploadTextureData(gfxTexture, 0, texture.levels);
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
        const texture = name === null ? null : this.decoded.get(name) ?? null;
        const magFilter = texture?.magFilter ?? 1;
        const minFilter = texture?.minFilter ?? 1;
        mapping.gfxSampler = this.samplers.get(`${clampS}|${clampT}|${magFilter}|${minFilter}`) ??
            this.samplers.get(`${clampS}|${clampT}|1|1`)!;
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
