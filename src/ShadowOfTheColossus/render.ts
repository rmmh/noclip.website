import { DeviceProgram } from '../Program.js';
import { GfxShaderLibrary } from '../gfx/helpers/GfxShaderLibrary.js';
import { createBufferFromData } from '../gfx/helpers/BufferHelpers.js';
import { fillMatrix4x4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { GfxBuffer, GfxBufferFrequencyHint, GfxBufferUsage, GfxCullMode, GfxDevice, GfxFormat, GfxInputLayout, GfxMipFilterMode, GfxProgram, GfxSampler, GfxTexFilterMode, GfxTexture, GfxVertexBufferDescriptor, GfxVertexBufferFrequency, GfxWrapMode, makeTextureDescriptor2D } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { GfxRenderInst, GfxRenderInstManager } from '../gfx/render/GfxRenderInstManager.js';
import { DecodedTexture, TerrainMesh } from './bin.js';
import { mat4 } from 'gl-matrix';
import { TextureMapping } from '../TextureHolder.js';
import { AABB, Frustum } from '../Geometry.js';

export class TerrainProgram extends DeviceProgram {
    public static ub_SceneParams = 0;
    public override both = `
precision highp float;
${GfxShaderLibrary.MatrixLibrary}
layout(std140) uniform ub_SceneParams { Mat4x4 u_ClipFromWorld; };
varying vec4 v_Color;
varying vec2 v_TexCoord;
layout(binding=0) uniform sampler2D u_Texture;
#ifdef VERT
layout(location=0) attribute vec3 a_Position;
layout(location=1) attribute vec3 a_Normal;
layout(location=2) attribute vec4 a_Color;
layout(location=3) attribute vec2 a_TexCoord;
void mainVS() {
    gl_Position = UnpackMatrix(u_ClipFromWorld) * vec4(a_Position, 1.0);
    float light = 0.55 + 0.45 * max(dot(a_Normal, normalize(vec3(0.3, 1.0, 0.2))), 0.0);
    v_Color = vec4(a_Color.rgb * light, a_Color.a);
    v_TexCoord = a_TexCoord;
}
#endif
#ifdef FRAG
void mainPS() {
    gl_FragColor = texture(SAMPLER_2D(u_Texture), v_TexCoord) * v_Color;
    if (gl_FragColor.a < 0.25)
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
        this.isProp = mesh.isProp;
        this.vertexCount = mesh.vertices.length / 12;
        for (let i = 0; i < mesh.vertices.length; i += 12) {
            this.bounds.min[0] = Math.min(this.bounds.min[0], mesh.vertices[i]);
            this.bounds.min[1] = Math.min(this.bounds.min[1], mesh.vertices[i + 1]);
            this.bounds.min[2] = Math.min(this.bounds.min[2], mesh.vertices[i + 2]);
            this.bounds.max[0] = Math.max(this.bounds.max[0], mesh.vertices[i]);
            this.bounds.max[1] = Math.max(this.bounds.max[1], mesh.vertices[i + 1]);
            this.bounds.max[2] = Math.max(this.bounds.max[2], mesh.vertices[i + 2]);
        }
    }
    public prepareToRender(manager: GfxRenderInstManager, inputLayout: GfxInputLayout, frustum: Frustum): void {
        if (!frustum.contains(this.bounds))
            return;
        const inst = manager.newRenderInst();
        inst.setVertexInput(inputLayout, this.descriptor, null);
        inst.setSamplerBindingsFromTextureMappings(this.mapping);
        inst.setDrawCount(this.vertexCount);
        manager.submitRenderInst(inst);
    }
    public destroy(device: GfxDevice): void { device.destroyBuffer(this.buffer); }
}

export class TerrainTextures {
    private textures = new Map<string, GfxTexture>();
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
            const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, texture.width, texture.height, 1));
            device.setResourceName(gfxTexture, texture.name);
            device.uploadTextureData(gfxTexture, 0, [texture.pixels]);
            this.textures.set(texture.name, gfxTexture);
        }
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

export function makeTerrainPipeline(cache: GfxRenderCache): { program: GfxProgram; inputLayout: GfxInputLayout } {
    const program = cache.createProgram(new TerrainProgram());
    const inputLayout = cache.createInputLayout({
        vertexAttributeDescriptors: [
            { location: 0, bufferIndex: 0, bufferByteOffset: 0, format: GfxFormat.F32_RGB },
            { location: 1, bufferIndex: 0, bufferByteOffset: 12, format: GfxFormat.F32_RGB },
            { location: 2, bufferIndex: 0, bufferByteOffset: 24, format: GfxFormat.F32_RGBA },
            { location: 3, bufferIndex: 0, bufferByteOffset: 40, format: GfxFormat.F32_RG },
        ],
        vertexBufferDescriptors: [{ byteStride: 48, frequency: GfxVertexBufferFrequency.PerVertex }],
        indexBufferFormat: null,
    });
    return { program, inputLayout };
}

export function fillSceneParams(template: GfxRenderInst, clipFromWorld: mat4): void {
    template.setBindingLayouts([{ numUniformBuffers: 1, numSamplers: 1 }]);
    template.setMegaStateFlags({ cullMode: GfxCullMode.None });
    const offs = template.allocateUniformBuffer(TerrainProgram.ub_SceneParams, 16);
    fillMatrix4x4(template.mapUniformBufferF32(TerrainProgram.ub_SceneParams), offs, clipFromWorld);
}
