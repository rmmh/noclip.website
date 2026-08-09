import * as F3DEX from '../BanjoKazooie/f3dex.js';
import * as RDP from '../Common/N64/RDP.js';
import * as RSP from '../Common/N64/RSP.js';
import * as Viewer from '../viewer.js';

import { mat4, vec3 } from 'gl-matrix';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { F3DEX_Program } from '../BanjoKazooie/render.js';
import { computeViewMatrix, computeViewMatrixSkybox } from '../Camera.js';
import { CalcBillboardFlags, calcBillboardMatrix } from '../MathHelpers.js';
import { DeviceProgram } from '../Program.js';
import { TextureMapping } from '../TextureHolder.js';
import { fillMatrix4x2, fillMatrix4x3, fillVec3v, fillVec4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { GfxBindingLayoutDescriptor, GfxBlendFactor, GfxBuffer, GfxBufferFrequencyHint, GfxBufferUsage, GfxCompareMode, GfxCullMode, GfxDevice, GfxFormat, GfxInputLayout, GfxInputLayoutBufferDescriptor, GfxMegaStateDescriptor, GfxProgram, GfxSampler, GfxTexture, GfxVertexAttributeDescriptor, GfxVertexBufferDescriptor, GfxVertexBufferFrequency } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { GfxRendererLayer, GfxRenderInstManager, makeSortKey, setSortKeyBias, setSortKeyDepth } from '../gfx/render/GfxRenderInstManager.js';
import { createBufferFromData } from '../gfx/helpers/BufferHelpers.js';
import { align, assert, assertExists, nArray } from '../util.js';
import { Color, colorNewCopy, colorNewFromRGBA } from '../Color.js';

class GoldenEyeProgram extends F3DEX_Program {
    constructor(otherModeH: number, otherModeL: number, combine: RDP.CombineParams, blendAlpha = 0.5, tiles: RDP.TileState[] = [], lightCount = 0) {
        super(otherModeH, otherModeL, combine, blendAlpha, tiles, lightCount);
        this.both = this.both.replace(
            '#endif\n};\n\nlayout(std140) uniform ub_CombineParameters',
            `#endif
#ifdef USE_VERTEX_COLOR_SCALE
    vec4 u_VertexColorScale;
#endif
#ifdef USE_MODEL_SHADE
    vec4 u_ModelShade;
#endif
};

layout(std140) uniform ub_CombineParameters`,
        );

        const vertexMainEnd = this.vert.lastIndexOf('\n}');
        assert(vertexMainEnd >= 0);
        this.vert = `${this.vert.slice(0, vertexMainEnd)}
#ifdef USE_VERTEX_COLOR_SCALE
    v_Color *= u_VertexColorScale;
#endif
${this.vert.slice(vertexMainEnd)}`;

        this.frag = this.frag.replace('\n#ifdef USE_FOG', `
#ifdef USE_MODEL_SHADE
    // The normal object path loads room shade into FOG RGBA and uses
    // G_RM_FOG_PRIM_A as an object-lighting blend, separately from distance fog.
    t_Color.rgb = mix(t_Color.rgb, u_ModelShade.rgb, u_ModelShade.a);
#endif

#ifdef USE_FOG`);
    }
}

export class SceneLighting {
    public diffuseColor: vec3[] = [];
    public diffuseDirection: vec3[] = [];
    public ambientColor: vec3 = vec3.fromValues(.5, .5, .5);
};

export function makeVertexBufferData(v: F3DEX.Vertex[]): Float32Array {
    const buf = new Float32Array(10 * v.length);
    let j = 0;
    for (let i = 0; i < v.length; i++) {
        buf[j++] = v[i].x;
        buf[j++] = v[i].y;
        buf[j++] = v[i].z;
        buf[j++] = v[i].matrixIndex;

        buf[j++] = v[i].tx;
        buf[j++] = v[i].ty;

        buf[j++] = v[i].c0;
        buf[j++] = v[i].c1;
        buf[j++] = v[i].c2;
        buf[j++] = v[i].a;
    }
    return buf;
}

export class DrawCallRenderData {
    public textures: GfxTexture[] = [];
    public samplers: GfxSampler[] = [];

    public vertexBuffer: GfxBuffer;
    public inputLayout: GfxInputLayout;
    public vertexBufferDescriptors: GfxVertexBufferDescriptor[];
    public vertexBufferData: Float32Array;
    private ownsTextures: boolean;

    constructor(private device: GfxDevice, private renderCache: GfxRenderCache, private textureCache: RDP.TextureCache, private segmentBuffers: ArrayBufferSlice[], private drawCall: DrawCall, sharedTextures?: GfxTexture[]) {
        const textures = textureCache.textures;
        this.ownsTextures = sharedTextures === undefined;
        if (sharedTextures !== undefined)
            this.textures = sharedTextures;
        for (let i = 0; i < textures.length; i++) {
            const tex = textures[i];
            if (sharedTextures === undefined)
                this.textures.push(RDP.translateToGfxTexture(device, tex));
            // Samplers remain per draw-call arrays. GoldenEye's C0 command can
            // select different clamp/mirror state for the same image, while
            // the immutable GPU texel allocation itself is safe to share.
            this.samplers.push(RDP.translateSampler(device, renderCache, tex));
        }

        this.vertexBufferData = makeVertexBufferData(drawCall.vertices);
        this.vertexBuffer = createBufferFromData(device, GfxBufferUsage.Vertex, drawCall.dynamicGeometry ? GfxBufferFrequencyHint.Dynamic : GfxBufferFrequencyHint.Static, this.vertexBufferData.buffer);

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: F3DEX_Program.a_Position, bufferIndex: 0, format: GfxFormat.F32_RGBA, bufferByteOffset: 0*0x04, },
            { location: F3DEX_Program.a_TexCoord, bufferIndex: 0, format: GfxFormat.F32_RG,   bufferByteOffset: 4*0x04, },
            { location: F3DEX_Program.a_Color   , bufferIndex: 0, format: GfxFormat.F32_RGBA, bufferByteOffset: 6*0x04, },
        ];

        const vertexBufferDescriptors: GfxInputLayoutBufferDescriptor[] = [
            { byteStride: 10*0x04, frequency: GfxVertexBufferFrequency.PerVertex, },
        ];

        this.inputLayout = renderCache.createInputLayout({
            indexBufferFormat: null,
            vertexBufferDescriptors,
            vertexAttributeDescriptors,
        });

        this.vertexBufferDescriptors = [
            { buffer: this.vertexBuffer },
        ];
    }

    public updateTextures(): void {
        const textures = this.textureCache.textures;
        for (let i = 0; i < textures.length; i++) {
            const tex = textures[i];
            const reprocessed_tex = RDP.translateTileTexture(this.segmentBuffers, tex.dramAddr, tex.dramPalAddr, tex.tile, false);
            this.device.uploadTextureData(this.textures[i], 0, [reprocessed_tex.pixels]);
        }

    }

    public updateBuffers(): void {
        assert(this.drawCall.dynamicGeometry);
        this.vertexBufferData = makeVertexBufferData(this.drawCall.vertices);
        this.device.uploadBufferData(this.vertexBuffer, 0, new Uint8Array(this.vertexBufferData.buffer));
    }

    public destroy(device: GfxDevice): void {
        if (this.ownsTextures)
            for (let i = 0; i < this.textures.length; i++)
                device.destroyTexture(this.textures[i]);
        device.destroyBuffer(this.vertexBuffer);
    }
}

export const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 3, numSamplers: 2, },
];


export class DrawCall {
    // Represents a single draw call with a single pipeline state.
    public SP_GeometryMode: number = 0;
    public SP_TextureState = new F3DEX.TextureState();
    public DP_OtherModeL: number = 0;
    public DP_OtherModeH: number = 0;
    public DP_Combine: RDP.CombineParams;
    public DP_PrimColor: Color = colorNewFromRGBA(1,1,1,1);
    public DP_EnvColor: Color = colorNewFromRGBA(1,1,1,1);

    public textureIndices: number[] = [];
    public textureScaleOverrides: [number, number][] = [[1, 1], [1, 1]];
    public normalizedTextureCoordinates = false;
    public textureCache: RDP.TextureCache;

    public vertexCount: number = 0;
    public vertices: F3DEX.Vertex[] = [];

    public renderData: DrawCallRenderData | null = null;

    public dynamicGeometry: boolean = false;
    public dynamicTextures: Set<number> = new Set<number>();
    public lastTextureUpdate: number = 0;

    // TODO: delete
    // public originalUVs: number[] = [];

    public destroy(device: GfxDevice): void {
        if (this.renderData !== null) {
            this.renderData.destroy(device);
            this.renderData = null;
        }
    }
}

const vec3Scratch: vec3 = vec3.create();
export class DrawCallInstance {
    static viewMatrixScratch = mat4.create();
    static modelViewScratch = mat4.create();
    static texMatrixScratch = mat4.create();
    static texAnimMatrixScratch = mat4.create();
    private textureEntry: RDP.Texture[] = [];
    private vertexColorsEnabled = true;
    private texturesEnabled = true;
    private monochromeVertexColorsEnabled = false;
    private alphaVisualizerEnabled = false;
    private fogNear = 0;
    private fogFar = 0;
    private fogColor: Color | null = null;
    private textureScrollS = 0;
    private textureScrollT = 0;
    private textureOffsetS = 0;
    private textureOffsetT = 0;
    private textureScrollS1 = 0;
    private textureScrollT1 = 0;
    private textureOffsetS1 = 0;
    private textureOffsetT1 = 0;
    private textureAnimationEnabled = false;
    private textureAnimationCenterS = 0.5;
    private textureAnimationCenterT = 0.5;
    private textureAnimationScaleS = 1;
    private textureAnimationScaleT = 1;
    private textureAnimationRotation = 0;
    private vertexColorScale: Color | null = null;
    private modelShade: Color | null = null;
    private sortLayer: GfxRendererLayer;
    private lodMin = 0;
    private lodMax: number | null = null;
    private sortPosition: vec3 | null = null;
    private sortBias = 0;
    private megaStateFlags: Partial<GfxMegaStateDescriptor>;
    private program!: DeviceProgram;
    private gfxProgram: GfxProgram | null = null;
    private textureMappings = nArray(2, () => new TextureMapping());
    public envAlpha = 1;
    public visible = true;

    constructor(private drawCall: DrawCall, private textureCache: RDP.TextureCache, private sceneLights: SceneLighting | null = null) {
        assert(drawCall.renderData !== null);
        this.reloadTextureMappings();
        this.megaStateFlags = RDP.translateRenderMode(this.drawCall.DP_OtherModeL);
        const blendState = this.megaStateFlags.attachmentsState?.[0]?.rgbBlendState;
        this.sortLayer = blendState !== undefined && blendState.blendDstFactor !== GfxBlendFactor.Zero
            ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE;
        this.setBackfaceCullingEnabled(false);
        this.createProgram();
    }

    // TODO: destroy?

    public reloadTextureMappings() {
        for (let i = 0; i < this.textureMappings.length; i++) {
            if (i < this.drawCall.textureIndices.length) {
                const idx = this.drawCall.textureIndices[i];
                this.textureEntry[i] = this.textureCache.textures[idx];
                this.textureMappings[i].gfxTexture = this.drawCall.renderData!.textures[idx];
                this.textureMappings[i].gfxSampler = this.drawCall.renderData!.samplers[idx];
            }
        }
    }

    /** Override a texture binding for this instance without mutating the
     * shared display-list DrawCall used by other placed objects. */
    public setTextureIndex(binding: number, textureIndex: number): void {
        if (binding < 0 || binding >= this.textureMappings.length || this.drawCall.renderData === null)
            return;
        this.textureEntry[binding] = this.textureCache.textures[textureIndex];
        this.textureMappings[binding].gfxTexture = this.drawCall.renderData.textures[textureIndex];
        this.textureMappings[binding].gfxSampler = this.drawCall.renderData.samplers[textureIndex];
    }

    private createProgram(): void {
        const nLights = (this.sceneLights !== null) ? this.sceneLights.diffuseColor.length : 0;
        const program = new GoldenEyeProgram(this.drawCall.DP_OtherModeH, this.drawCall.DP_OtherModeL, this.drawCall.DP_Combine, .5, [], nLights);
        program.defines.set('BONE_MATRIX_COUNT', '1');

        if (this.texturesEnabled && this.drawCall.textureIndices.length) {
            program.defines.set('USE_TEXTURE', '1');
        }

        const shade = (this.drawCall.SP_GeometryMode & F3DEX.RSP_Geometry.G_SHADE) !== 0;
        if (this.vertexColorsEnabled && shade)
            program.defines.set('USE_VERTEX_COLOR', '1');

        if (this.drawCall.SP_GeometryMode & F3DEX.RSP_Geometry.G_LIGHTING) {
            program.defines.set('LIGHTING', '1');
            if (this.sceneLights !== null) {
                program.defines.set('PARAMETERIZED_LIGHTING', '1');
            }
        }

        if (this.drawCall.SP_GeometryMode & F3DEX.RSP_Geometry.G_TEXTURE_GEN)
            program.defines.set('TEXTURE_GEN', '1');

        // many display lists seem to set this flag without setting texture_gen,
        // despite this one being dependent on it
        if (this.drawCall.SP_GeometryMode & F3DEX.RSP_Geometry.G_TEXTURE_GEN_LINEAR)
            program.defines.set('TEXTURE_GEN_LINEAR', '1');

        if (this.monochromeVertexColorsEnabled)
            program.defines.set('USE_MONOCHROME_VERTEX_COLOR', '1');

        if (this.alphaVisualizerEnabled)
            program.defines.set('USE_ALPHA_VISUALIZER', '1');

        if (this.fogColor !== null)
            program.defines.set('USE_FOG', '1');
        if (this.vertexColorScale !== null)
            program.defines.set('USE_VERTEX_COLOR_SCALE', '1');
        if (this.modelShade !== null)
            program.defines.set('USE_MODEL_SHADE', '1');


        this.program = program;
        this.gfxProgram = null;
    }

    public setBackfaceCullingEnabled(v: boolean): void {
        const cullMode = v ? GfxCullMode.Back : F3DEX.translateCullMode(this.drawCall.SP_GeometryMode);
        this.megaStateFlags.cullMode = cullMode;
    }

    public setDepthMode(write: boolean, compare: GfxCompareMode): void {
        this.megaStateFlags.depthWrite = write;
        this.megaStateFlags.depthCompare = compare;
    }

    public setRenderMode(otherModeL: number): void {
        this.megaStateFlags = RDP.translateRenderMode(otherModeL);
        const blendState = this.megaStateFlags.attachmentsState?.[0]?.rgbBlendState;
        this.sortLayer = blendState !== undefined && blendState.blendDstFactor !== GfxBlendFactor.Zero
            ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE;
        this.setBackfaceCullingEnabled(false);
    }

    public setTextureScroll(sPerSecond: number, tPerSecond: number): void {
        this.textureScrollS = sPerSecond;
        this.textureScrollT = tPerSecond;
    }

    public setTextureOffset(s: number, t: number): void {
        this.textureOffsetS = s;
        this.textureOffsetT = t;
    }

    public setSecondTextureMotion(sPerSecond: number, tPerSecond: number, sOffset: number, tOffset: number): void {
        this.textureScrollS1 = sPerSecond;
        this.textureScrollT1 = tPerSecond;
        this.textureOffsetS1 = sOffset;
        this.textureOffsetT1 = tOffset;
    }

    public setTextureAnimation(centerS: number, centerT: number, scaleS: number, scaleT: number, rotation: number): void {
        this.textureAnimationEnabled = true;
        this.textureAnimationCenterS = centerS;
        this.textureAnimationCenterT = centerT;
        this.textureAnimationScaleS = scaleS;
        this.textureAnimationScaleT = scaleT;
        this.textureAnimationRotation = rotation;
    }

    public enableVertexColorScale(): void {
        if (this.vertexColorScale === null) {
            this.vertexColorScale = colorNewFromRGBA(1, 1, 1, 1);
            this.createProgram();
        }
    }

    public setVertexColorScale(r: number, g: number, b: number, a: number): void {
        this.enableVertexColorScale();
        this.vertexColorScale!.r = r;
        this.vertexColorScale!.g = g;
        this.vertexColorScale!.b = b;
        this.vertexColorScale!.a = a;
    }

    public setModelShade(r: number, g: number, b: number, a: number): void {
        if (this.modelShade === null) {
            this.modelShade = colorNewFromRGBA(r, g, b, a);
            this.createProgram();
        } else {
            this.modelShade.r = r;
            this.modelShade.g = g;
            this.modelShade.b = b;
            this.modelShade.a = a;
        }
    }

    public setSortLayer(layer: GfxRendererLayer): void {
        this.sortLayer = layer;
    }

    public setLODRange(min: number, max: number): void {
        this.lodMin = min;
        this.lodMax = max;
    }

    public setSortPosition(x: number, y: number, z: number): void {
        if (this.sortPosition === null)
            this.sortPosition = vec3.create();
        vec3.set(this.sortPosition, x, y, z);
    }

    /** Stable ordering within an equal-depth translucent object. */
    public setSortBias(bias: number): void {
        this.sortBias = bias & 0xFF;
    }

    public setVertexColorsEnabled(v: boolean): void {
        this.vertexColorsEnabled = v;
        this.createProgram();
    }

    public setTexturesEnabled(v: boolean): void {
        this.texturesEnabled = v;
        this.createProgram();
    }

    public setMonochromeVertexColorsEnabled(v: boolean): void {
        this.monochromeVertexColorsEnabled = v;
        this.createProgram();
    }

    public setAlphaVisualizerEnabled(v: boolean): void {
        this.alphaVisualizerEnabled = v;
        this.createProgram();
    }

    public setFog(near: number, far: number, color: Color | null): void {
        this.fogNear = near;
        this.fogFar = far;
        this.fogColor = color === null ? null : colorNewCopy(color);
        this.createProgram();
    }

    private computeTextureMatrix(m: mat4, textureEntryIndex: number): void {
        if (textureEntryIndex === 0 && this.drawCall.normalizedTextureCoordinates) {
            mat4.identity(m);
        } else if (this.textureEntry[textureEntryIndex] !== undefined) {
            const entry = this.textureEntry[textureEntryIndex];
            RSP.calcTextureMatrixFromRSPState(m, this.drawCall.SP_TextureState.s, this.drawCall.SP_TextureState.t, entry.width, entry.height, entry.tile.shifts, entry.tile.shiftt);
            const scale = this.drawCall.textureScaleOverrides[textureEntryIndex];
            if (scale !== undefined) {
                m[0] *= scale[0];
                m[5] *= scale[1];
            }
        } else {
            mat4.identity(m);
        }
        if (textureEntryIndex === 0 && this.textureAnimationEnabled) {
            const a = DrawCallInstance.texAnimMatrixScratch;
            mat4.identity(a);
            mat4.translate(a, a, [this.textureAnimationCenterS, this.textureAnimationCenterT, 0]);
            mat4.rotateZ(a, a, this.textureAnimationRotation);
            mat4.scale(a, a, [this.textureAnimationScaleS, this.textureAnimationScaleT, 1]);
            mat4.translate(a, a, [-0.5, -0.5, 0]);
            mat4.multiply(m, a, m);
        }
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, drawMatrix: mat4, isSkybox: boolean = false, isBillboard: boolean = false): void {
        if (!this.visible)
            return;

        if (this.lodMax !== null && !isSkybox) {
            computeViewMatrix(DrawCallInstance.viewMatrixScratch, viewerInput.camera);
            mat4.mul(DrawCallInstance.modelViewScratch, DrawCallInstance.viewMatrixScratch, drawMatrix);
            const distance = Math.max(0, -DrawCallInstance.modelViewScratch[14]);
            // modelUpdateDistanceRelations multiplies both authored thresholds
            // by Model.scale. The instance matrix carries that same canonical
            // and setup scale in its first basis vector.
            const scale = Math.hypot(drawMatrix[0], drawMatrix[1], drawMatrix[2]);
            if (!((this.lodMin === 0 || distance > this.lodMin * scale) && distance <= this.lodMax * scale))
                return;
        }

        if (this.gfxProgram === null)
            this.gfxProgram = renderInstManager.gfxRenderCache.createProgram(this.program);

        const renderInst = renderInstManager.newRenderInst();
        renderInst.setVertexInput(this.drawCall.renderData!.inputLayout, this.drawCall.renderData!.vertexBufferDescriptors, null);

        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setSamplerBindingsFromTextureMappings(this.textureMappings);
        renderInst.setMegaStateFlags(this.megaStateFlags);
        renderInst.setDrawCount(this.drawCall.vertexCount);

        let offs;

        const fogWords = this.fogColor !== null ? 8 : 0;
        const vertexColorWords = this.vertexColorScale !== null ? 4 : 0;
        const modelShadeWords = this.modelShade !== null ? 4 : 0;
        if(this.sceneLights !== null) {
            offs = renderInst.allocateUniformBuffer(F3DEX_Program.ub_DrawParams, (12*2 + 8*2 + this.sceneLights.diffuseColor.length * 8 + 4 + fogWords + vertexColorWords + modelShadeWords))
        }
        else {
            offs = renderInst.allocateUniformBuffer(F3DEX_Program.ub_DrawParams, 12*2 + 8*2 + fogWords + vertexColorWords + modelShadeWords)
        }

        const mappedF32 = renderInst.mapUniformBufferF32(F3DEX_Program.ub_DrawParams);

        if (!isSkybox) {
            computeViewMatrix(DrawCallInstance.viewMatrixScratch, viewerInput.camera);
        } else {
            mat4.identity(DrawCallInstance.viewMatrixScratch);
        }

        mat4.mul(DrawCallInstance.modelViewScratch, DrawCallInstance.viewMatrixScratch, drawMatrix);
        renderInst.sortKey = makeSortKey(this.sortLayer);
        if ((this.sortLayer & GfxRendererLayer.TRANSLUCENT) !== 0) {
            let sortDepth = Math.max(0, -DrawCallInstance.modelViewScratch[14]);
            if (this.sortPosition !== null) {
                vec3.transformMat4(vec3Scratch, this.sortPosition, DrawCallInstance.viewMatrixScratch);
                sortDepth = Math.max(0, -vec3Scratch[2]);
            }
            renderInst.sortKey = setSortKeyDepth(renderInst.sortKey, sortDepth);
            renderInst.sortKey = setSortKeyBias(renderInst.sortKey, this.sortBias);
        }
        if (isBillboard) {
            calcBillboardMatrix(DrawCallInstance.modelViewScratch, DrawCallInstance.modelViewScratch, CalcBillboardFlags.UseRollGlobal | CalcBillboardFlags.PriorityZ | CalcBillboardFlags.UseZPlane);
        }
        offs += fillMatrix4x3(mappedF32, offs, DrawCallInstance.modelViewScratch);


        this.computeTextureMatrix(DrawCallInstance.texMatrixScratch, 0);
        DrawCallInstance.texMatrixScratch[12] += this.textureOffsetS + this.textureScrollS * viewerInput.time / 1000;
        DrawCallInstance.texMatrixScratch[13] += this.textureOffsetT + this.textureScrollT * viewerInput.time / 1000;
        offs += fillMatrix4x2(mappedF32, offs, DrawCallInstance.texMatrixScratch);

        this.computeTextureMatrix(DrawCallInstance.texMatrixScratch, 1);
        DrawCallInstance.texMatrixScratch[12] += this.textureOffsetS1 + this.textureScrollS1 * viewerInput.time / 1000;
        DrawCallInstance.texMatrixScratch[13] += this.textureOffsetT1 + this.textureScrollT1 * viewerInput.time / 1000;
        offs += fillMatrix4x2(mappedF32, offs, DrawCallInstance.texMatrixScratch);

        if(this.sceneLights !== null) {
            const n_lights = this.sceneLights.diffuseColor.length;
            computeViewMatrixSkybox(DrawCallInstance.viewMatrixScratch, viewerInput.camera);
            
            for (let i = 0; i < n_lights; i++) {
                offs += fillVec3v(mappedF32, offs, this.sceneLights.diffuseColor[i]);
            }
            
            for (let i = 0; i < n_lights; i++) {
                vec3.transformMat4(vec3Scratch, this.sceneLights.diffuseDirection[i], DrawCallInstance.viewMatrixScratch);
                offs += fillVec3v(mappedF32, offs, vec3Scratch);
            }

            offs += fillVec3v(mappedF32, offs, this.sceneLights.ambientColor);
        }

        if (this.fogColor !== null) {
            offs += fillVec4(mappedF32, offs, this.fogNear, this.fogFar, 0, 0);
            offs += fillVec4(mappedF32, offs, this.fogColor.r, this.fogColor.g, this.fogColor.b, this.fogColor.a);
        }
        if (this.vertexColorScale !== null)
            offs += fillVec4(mappedF32, offs, this.vertexColorScale.r, this.vertexColorScale.g, this.vertexColorScale.b, this.vertexColorScale.a);
        if (this.modelShade !== null)
            offs += fillVec4(mappedF32, offs, this.modelShade.r, this.modelShade.g, this.modelShade.b, this.modelShade.a);

        const primColor = this.drawCall.DP_PrimColor;
        offs = renderInst.allocateUniformBuffer(F3DEX_Program.ub_CombineParams, 8);
        const comb = renderInst.mapUniformBufferF32(F3DEX_Program.ub_CombineParams);
        offs += fillVec4(comb, offs, primColor.r, primColor.g, primColor.b, primColor.a);
        const envColor = this.drawCall.DP_EnvColor;
        offs += fillVec4(comb, offs, envColor.r, envColor.g, envColor.b, envColor.a * this.envAlpha);

        renderInstManager.submitRenderInst(renderInst);
    }
}

