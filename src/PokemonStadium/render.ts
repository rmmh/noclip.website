import * as Viewer from '../viewer.js';
import * as RDP from '../Common/N64/RDP.js';
import * as F3DEX2 from './F3DEX2.js';

import { RenderData, F3DEX_Program } from '../BanjoKazooie/render.js';
import { vec4, mat4 } from 'gl-matrix';
import { DeviceProgram } from '../Program.js';
import { GfxMegaStateDescriptor, GfxProgram, GfxCullMode, GfxDevice, GfxTexture } from '../gfx/platform/GfxPlatform.js';
import { nArray } from '../util.js';
import { TextureMapping } from '../TextureHolder.js';
import { GfxRenderInstManager, makeSortKey, GfxRendererLayer } from '../gfx/render/GfxRenderInstManager.js';
import { computeViewMatrixSkybox, computeViewMatrix } from '../Camera.js';
import { fillVec4, fillMatrix4x2, fillMatrix4x3, fillVec4v } from '../gfx/helpers/UniformBufferHelpers.js';
import { calcBillboardMatrix, CalcBillboardFlags } from '../MathHelpers.js';
import { calcTextureMatrixFromRSPState } from '../Common/N64/RSP.js';

const viewMatrixScratch = mat4.create();
const modelViewScratch = mat4.create();
const texMatrixScratch = mat4.create();
const colorScratch = vec4.create();

export class DrawCallInstance {
    public visible = true;
    public animationVisibility: { animation: number; start: number; end: number; invert: boolean } | null = null;

    private textureEntry: RDP.Texture[] = [];
    private vertexColorsEnabled = true;
    private texturesEnabled = true;
    private monochromeVertexColorsEnabled = false;
    private alphaVisualizerEnabled = false;
    private megaStateFlags: Partial<GfxMegaStateDescriptor>;
    private program!: DeviceProgram;
    private gfxProgram: GfxProgram | null = null;
    private textureMappings = nArray(2, () => new TextureMapping());
    private callbackTextureFrame = -1;
    private currentTime = 0;
    private primColorOverride: vec4 | null = null;
    private envColorOverride: vec4 | null = null;
    private instancePrimColorOverrides: (vec4 | null)[];
    private instanceEnvColorOverrides: (vec4 | null)[];
    private modelTint = vec4.fromValues(1, 1, 1, 0);
    private modelPrimLOD: number | null = null;
    private static readonly ub_ModelTint = 3;

    constructor(private geometryData: RenderData, private drawCall: F3DEX2.DrawCall, private drawMatrices: mat4[], private billboard: number, private stadiumLayer: number = -1, private stadiumOrder: number = 0, private parameterizedLighting: boolean = true, private screenSpace: boolean = false) {
        this.instancePrimColorOverrides = nArray(drawMatrices.length, () => null);
        this.instanceEnvColorOverrides = nArray(drawMatrices.length, () => null);
        for (let i = 0; i < this.textureMappings.length; i++) {
            if (i < this.drawCall.textureIndices.length) {
                const idx = this.drawCall.textureIndices[i];
                this.textureEntry[i] = geometryData.sharedOutput.textureCache.textures[idx];
                this.textureMappings[i].gfxTexture = geometryData.textures[idx];
                this.textureMappings[i].gfxSampler = geometryData.samplers[idx];
            }
        }

        this.megaStateFlags = F3DEX2.translateBlendMode(this.drawCall.SP_GeometryMode, this.drawCall.DP_OtherModeL);
        this.createProgram();
    }

    public setStadiumTextureVariant(textureIndex: number): void {
        const indices = this.drawCall.stadiumTextureVariants[textureIndex];
        if (indices === undefined) return;
        for (let i = 0; i < this.textureMappings.length; i++) {
            const index = indices[i];
            if (index === undefined) continue;
            this.textureMappings[i].gfxTexture = this.geometryData.textures[index];
            this.textureMappings[i].gfxSampler = this.geometryData.samplers[index];
        }
    }

    public usesPokemonStadiumGsSelectedTextureAnimation(): boolean {
        return this.drawCall.stadiumGsSelectedTextureAnimation;
    }

    public setPokemonStadiumGsMaterialTextureVariant(variant: number): void {
        const textureIndex = this.drawCall.stadiumGsMaterialVariantTextureIndices[variant];
        if (textureIndex !== undefined) this.setStadiumTextureVariant(textureIndex);
    }

    public setPokemonStadiumGsCurrentPokemonTexture(texture: GfxTexture): void {
        if (this.drawCall.stadiumGsCurrentPokemonTexture)
            this.textureMappings[0].gfxTexture = texture;
    }

    public usesPokemonStadiumGsCurrentPokemonTexture(): boolean {
        return this.drawCall.stadiumGsCurrentPokemonTexture;
    }

    public usesPokemonStadiumGsMaterialTextureVariants(): boolean {
        return this.drawCall.stadiumGsMaterialVariantTextureIndices.length !== 0;
    }

    public applyStadiumMaterialAnimation(textureIndices: number[]): void {
        const channel = this.drawCall.stadiumMaterialAnimationChannel;
        if (channel >= 0 && channel < textureIndices.length)
            this.setStadiumTextureVariant(textureIndices[channel]);
    }

    private createProgram(): void {
        const tiles: RDP.TileState[] = [];
        for (let i = 0; i < this.textureEntry.length; i++)
            tiles.push(this.textureEntry[i].tile);
        const program = this.programConstructor(this.drawCall.DP_OtherModeH, this.drawCall.DP_OtherModeL, this.drawCall.DP_Combine, 8 / 255, tiles);
        program.both = program.both.replace('    vec4 u_PrimColor;\n    vec4 u_EnvColor;',
            '    vec4 u_PrimColor[BONE_MATRIX_COUNT];\n    vec4 u_EnvColor[BONE_MATRIX_COUNT];')
            .replace('varying vec4 v_TexCoord;', 'varying vec4 v_TexCoord;\nvarying float v_BoneIndex;');
        program.vert = program.vert.replace('    int t_BoneIndex = int(a_Position.w);',
            '    int t_BoneIndex = int(a_Position.w);\n    v_BoneIndex = a_Position.w;');
        program.frag = program.frag.replace(/\bu_PrimColor\b/g, 'u_PrimColor[int(v_BoneIndex + 0.5)]')
            .replace(/\bu_EnvColor\b/g, 'u_EnvColor[int(v_BoneIndex + 0.5)]');
        program.frag = `
layout(std140) uniform ub_ModelTint {
    vec4 u_ModelTint;
};
${program.frag}`.replace('    gl_FragColor = t_Color;',
            '    t_Color.rgb = mix(t_Color.rgb, u_ModelTint.rgb, u_ModelTint.a);\n    gl_FragColor = t_Color;');
        if (this.drawCall.stadiumGsCurrentPokemonTexture) {
            // The source render target is RGBA5551. The portable GPU target is
            // RGBA8, so quantize immediately after sampling and before either
            // combiner cycle consumes TEXEL0.
            program.frag = program.frag.replace(
                '    t_Tex0 = Texture2D_N64(PP_SAMPLER_2D(u_Texture0), v_TexCoord.xy);',
                `    t_Tex0 = Texture2D_N64(PP_SAMPLER_2D(u_Texture0), v_TexCoord.xy);
    t_Tex0.rgb = floor(t_Tex0.rgb * 31.0 + 0.5) / 31.0;
    t_Tex0.a = step(0.5, t_Tex0.a);`,
            );
        }
        if (this.drawCall.stadiumIA8Flame) {
            // fragment31's common dynamic-model combiner uses TEXEL0 as an
            // IA mask between environment and primitive color. Express it
            // directly because the shared shader's two-cycle TEXEL swap
            // assumes both texture units are populated.
            program.frag = program.frag.replace('#ifdef USE_FOG', `
    t_Color.rgb = v_Color.rgb * mix(u_EnvColor[int(v_BoneIndex + 0.5)].rgb, u_PrimColor[int(v_BoneIndex + 0.5)].rgb, t_Tex0.r);
    t_Color.a = t_Tex0.a * v_Color.a;

#ifdef USE_FOG`);
        }
        if (this.drawCall.stadiumParticlePrimitiveEnvironment) {
            // set_particle_primitive_environment_combine:
            // (primitive - environment) * TEXEL0 + environment.
            // Keep this direct because the shared two-cycle translator does not
            // preserve COMBINED for Stadium's IA/I particle callbacks.
            program.frag = program.frag.replace('#ifdef USE_FOG', `
    t_Color.rgb = mix(u_EnvColor[int(v_BoneIndex + 0.5)].rgb, u_PrimColor[int(v_BoneIndex + 0.5)].rgb, t_Tex0.r);
    t_Color.a = t_Tex0.a * u_PrimColor[int(v_BoneIndex + 0.5)].a;

#ifdef USE_FOG`);
        }
        if (this.drawCall.stadiumDualTextureParticleColor) {
            // set_dual_texture_color_particle_combine first blends the two
            // authored masks at PRIM_LOD_FRAC=0x80, then applies the particle
            // primitive/environment palette in cycle two.
            program.frag = program.frag.replace('#ifdef USE_FOG', `
    vec4 t_ParticleMask = mix(t_Tex0, t_Tex1, 128.0 / 255.0);
    t_Color.rgb = mix(u_EnvColor[int(v_BoneIndex + 0.5)].rgb, u_PrimColor[int(v_BoneIndex + 0.5)].rgb, t_ParticleMask.rgb);
    t_Color.a = t_Tex0.a * u_PrimColor[int(v_BoneIndex + 0.5)].a;

#ifdef USE_FOG`);
        }
        if (this.drawCall.stadiumLeerEyeMask) {
            // Leer uses two scrolling I4 masks. Its first cycle multiplies the
            // masks for color while interpolating their alpha by PRIM_LOD_FRAC;
            // cycle two palettes that result between environment and primitive.
            program.frag = program.frag.replace('#ifdef USE_FOG', `
    vec3 t_LeerMask = t_Tex1.rgb * t_Tex0.rgb;
    t_Color.rgb = mix(u_EnvColor[int(v_BoneIndex + 0.5)].rgb, u_PrimColor[int(v_BoneIndex + 0.5)].rgb, t_LeerMask);
    t_Color.a = mix(t_Tex1.a, t_Tex0.a, 100.0 / 255.0) * u_PrimColor[int(v_BoneIndex + 0.5)].a;

#ifdef USE_FOG`);
        }
        if (this.drawCall.stadiumGsParticleVertexAlphaScale) {
            // Stadium 2's phase-5 vertex callback multiplies each source Vtx
            // alpha by the live particle/effect alpha. Applying the same
            // factor after the translated combiner avoids manufacturing a
            // per-particle copy of the otherwise identical vertex buffer.
            program.frag = program.frag.replace('#ifdef USE_FOG', `
    t_Color.a *= u_PrimColor[int(v_BoneIndex + 0.5)].a;

#ifdef USE_FOG`);
        }
        if (this.stadiumLayer === 4) {
            // Stadium's cutout queues derive coverage from the sampled texel.
            // Feather vertices intentionally carry zero alpha, so the shared
            // Fast3D vertex-alpha test would discard the entire authored pass.
            program.frag = program.frag.replace(/if \(t_Color\.a < ([^&]+)&&/, 'if (t_Tex0.a < $1&&');
        }
        program.defines.set('BONE_MATRIX_COUNT', this.drawMatrices.length.toString());

        if (this.texturesEnabled && this.drawCall.textureIndices.length)
            program.defines.set('USE_TEXTURE', '1');

        const shade = (this.drawCall.SP_GeometryMode & F3DEX2.RSP_Geometry.G_SHADE) !== 0;
        if (this.vertexColorsEnabled && shade)
            program.defines.set('USE_VERTEX_COLOR', '1');

        if (this.drawCall.SP_GeometryMode & F3DEX2.RSP_Geometry.G_LIGHTING)
            program.defines.set('LIGHTING', '1');
        if (this.stadiumLayer >= 0 && this.parameterizedLighting && (this.drawCall.SP_GeometryMode & F3DEX2.RSP_Geometry.G_LIGHTING))
            program.defines.set('PARAMETERIZED_LIGHTING', '1');
        if (this.drawCall.SP_GeometryMode & F3DEX2.RSP_Geometry.G_TEXTURE_GEN)
            program.defines.set('TEXTURE_GEN', '1');

        if (this.drawCall.SP_GeometryMode & F3DEX2.RSP_Geometry.G_TEXTURE_GEN_LINEAR)
            program.defines.set('TEXTURE_GEN_LINEAR', '1');

        if (this.monochromeVertexColorsEnabled)
            program.defines.set('USE_MONOCHROME_VERTEX_COLOR', '1');

        if (this.alphaVisualizerEnabled)
            program.defines.set('USE_ALPHA_VISUALIZER', '1');

        program.defines.set('EXTRA_COMBINE', '1');

        this.program = program;
        this.gfxProgram = null;
    }

    public setBackfaceCullingEnabled(v: boolean): void {
        const cullMode = v ? F3DEX2.translateCullMode(this.drawCall.SP_GeometryMode) : GfxCullMode.None;
        this.megaStateFlags.cullMode = cullMode;
    }

    public setDepthWriteEnabled(v: boolean): void {
        this.megaStateFlags.depthWrite = v;
    }

    /** Override the per-draw RDP colors without rebuilding the display list. */
    public setCombineColors(prim: readonly [number, number, number, number] | null,
                            env: readonly [number, number, number, number] | null = null): void {
        if (prim === null) {
            this.primColorOverride = null;
        } else {
            if (this.primColorOverride === null) this.primColorOverride = vec4.create();
            vec4.set(this.primColorOverride, prim[0], prim[1], prim[2], prim[3]);
        }
        if (env === null) {
            this.envColorOverride = null;
        } else {
            if (this.envColorOverride === null) this.envColorOverride = vec4.create();
            vec4.set(this.envColorOverride, env[0], env[1], env[2], env[3]);
        }
    }

    /** Override RDP combine colors for one matrix-indexed particle instance. */
    public setInstanceCombineColors(index: number, prim: readonly [number, number, number, number] | null,
                                    env: readonly [number, number, number, number] | null = null): void {
        if (index < 0 || index >= this.drawMatrices.length) return;
        if (prim === null) this.instancePrimColorOverrides[index] = null;
        else {
            const color = this.instancePrimColorOverrides[index] ?? vec4.create();
            vec4.set(color, prim[0], prim[1], prim[2], prim[3]); this.instancePrimColorOverrides[index] = color;
        }
        if (env === null) this.instanceEnvColorOverrides[index] = null;
        else {
            const color = this.instanceEnvColorOverrides[index] ?? vec4.create();
            vec4.set(color, env[0], env[1], env[2], env[3]); this.instanceEnvColorOverrides[index] = color;
        }
    }

    public setModelTint(color: readonly [number, number, number, number] | null): void {
        if (color === null) vec4.set(this.modelTint, 1, 1, 1, 0);
        else vec4.set(this.modelTint, color[0], color[1], color[2], color[3]);
    }

    public setModelPrimLOD(value: number | null): void {
        this.modelPrimLOD = value;
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

    private computeTextureMatrix(m: mat4, textureEntryIndex: number): void {
        if (this.textureEntry[textureEntryIndex] !== undefined) {
            const entry = this.textureEntry[textureEntryIndex];
            const samplingTile = this.drawCall.stadiumTextureTiles[textureEntryIndex] ?? entry.tile;
            // pass in 1 for texture scale, since we've already rescaled the vertex coordinates
            calcTextureMatrixFromRSPState(m, 1, 1, entry.width, entry.height, samplingTile.shifts, samplingTile.shiftt);

            // shift by 10.2 UL coords, rescaled by texture size
            let sOffset = -samplingTile.uls / 4;
            let tOffset = -samplingTile.ult / 4;
            m[12] += sOffset / entry.width;
            m[13] += tOffset / entry.height;

            if (this.drawCall.stadiumDualTextureScroll) {
                // fragment31's Grimer/Muk callback decrements its scroll
                // counter once per rendered frame. Reproduce the moving tile
                // origins without rebuilding the RDP texture cache.
                const scroll = -Math.floor(this.currentTime * 30 / 1000);
                const q = scroll >> 4;
                const r = scroll >> 3;
                if (textureEntryIndex === 0) {
                    m[12] += -q / entry.width / 4;
                    m[13] += q / entry.height / 4;
                } else {
                    m[12] += q / entry.width / 4;
                    m[13] += r / entry.height / 4;
                }
            }

            const scrollSpeed = this.drawCall.stadiumTextureScrollSpeeds[textureEntryIndex];
            if (scrollSpeed !== undefined) {
                // gMoveEffectFrameCounter advances once per 30 Hz battle frame. The RDP
                // callbacks supply 10.2 tile origins, hence the /4 conversion.
                const frame = Math.floor(this.currentTime * 30 / 1000);
                m[12] += -(scrollSpeed[0] * frame) / 4 / entry.width;
                m[13] +=  (scrollSpeed[1] * frame) / 4 / entry.height;
            }
        } else {
            mat4.identity(m);
        }
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, isSkybox: boolean): void {
        if (!this.visible)
            return;

        this.currentTime = viewerInput.time;
        for (const animation of this.drawCall.stadiumLightAnimations) {
            const frame = Math.floor(viewerInput.time * 30 / 1000) % animation.period;
            let segment = animation.times.length - 2;
            for (let i = 0; i + 1 < animation.times.length; i++) {
                if (frame >= animation.times[i] && frame < animation.times[i + 1]) { segment = i; break; }
            }
            const start = animation.times[segment], end = animation.times[segment + 1];
            const t = end === start ? 0 : (frame - start) / (end - start);
            const color = this.drawCall.stadiumLightColors[animation.index];
            if (color !== undefined) for (let channel = 0; channel < 3; channel++)
                color[channel] = Math.floor(animation.colors[segment][channel] * (1 - t) +
                    animation.colors[segment + 1][channel] * t) / 255;
        }
        if (this.drawCall.stadiumFreeRunningTextureAnimation) {
            const frame = Math.floor(viewerInput.time * 30 / 1000) & 7;
            if (frame !== this.callbackTextureFrame) {
                this.setStadiumTextureVariant(frame);
                this.callbackTextureFrame = frame;
            }
        }

        if (this.gfxProgram === null)
            this.gfxProgram = renderInstManager.gfxRenderCache.createProgram(this.program);

        const renderInst = renderInstManager.newRenderInst();
        renderInst.setGfxProgram(this.gfxProgram);

        // TODO: figure out layers
        if (!(this.drawCall.DP_OtherModeL & (1 << RDP.OtherModeL_Layout.Z_UPD)))
            renderInst.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT);
        if (this.stadiumLayer >= 0)
            renderInst.sortKey = ((this.stadiumLayer & 0x0F) << 24) | (this.stadiumOrder & 0x00FFFFFF);

        renderInst.setSamplerBindingsFromTextureMappings(this.textureMappings);
        renderInst.setMegaStateFlags(this.megaStateFlags);
        renderInst.setDrawCount(this.drawCall.indexCount, this.drawCall.firstIndex);

        const stadiumLighting = this.stadiumLayer >= 0 && this.parameterizedLighting && (this.drawCall.SP_GeometryMode & F3DEX2.RSP_Geometry.G_LIGHTING) !== 0;
        const lightCount = this.drawCall.stadiumLightColors.length !== 0 ? this.drawCall.stadiumLightColors.length : 2;
        let offs = renderInst.allocateUniformBuffer(F3DEX_Program.ub_DrawParams, 12 * this.drawMatrices.length + 8 * 2 + (stadiumLighting ? lightCount * 8 + 4 : 0));
        const mappedF32 = renderInst.mapUniformBufferF32(F3DEX_Program.ub_DrawParams);

        if (isSkybox)
            computeViewMatrixSkybox(viewMatrixScratch, viewerInput.camera);
        else
            computeViewMatrix(viewMatrixScratch, viewerInput.camera);

        for (let i = 0; i < this.drawMatrices.length; i++) {
            if (this.screenSpace)
                mat4.copy(modelViewScratch, this.drawMatrices[i]);
            else
                mat4.mul(modelViewScratch, viewMatrixScratch, this.drawMatrices[i]);
            if (this.billboard & 16)
                calcBillboardMatrix(modelViewScratch, modelViewScratch, CalcBillboardFlags.UseRollGlobal | CalcBillboardFlags.PriorityZ | CalcBillboardFlags.UseZPlane);
            else if (this.billboard & 8)
                calcBillboardMatrix(modelViewScratch, modelViewScratch, CalcBillboardFlags.UseRollLocal | CalcBillboardFlags.PriorityZ | CalcBillboardFlags.UseZPlane);
            else if (this.billboard & 2)
                calcBillboardMatrix(modelViewScratch, modelViewScratch, CalcBillboardFlags.UseRollLocal | CalcBillboardFlags.PriorityY | CalcBillboardFlags.UseZPlane);
            offs += fillMatrix4x3(mappedF32, offs, modelViewScratch);
        }

        this.computeTextureMatrix(texMatrixScratch, 0);
        offs += fillMatrix4x2(mappedF32, offs, texMatrixScratch);

        this.computeTextureMatrix(texMatrixScratch, 1);
        offs += fillMatrix4x2(mappedF32, offs, texMatrixScratch);

        if (stadiumLighting) {
            const graphLights = this.drawCall.stadiumLightColors.length !== 0;
            const colors = graphLights ? this.drawCall.stadiumLightColors : [[1, 1, 1], [0.5, 0.5, 0.5]];
            // BattleLight_UpdateKeyDirection / UpdateFillDirection keep these
            // directions camera-relative, so fallback vectors are already in
            // view space. Graph-owned lights remain world-space.
            const directions = graphLights ? this.drawCall.stadiumLightDirections : [[-0.5, 0.7071068, 0.5], [0.5, -0.7071068, -0.5]];
            for (const color of colors) offs += fillVec4(mappedF32, offs, color[0], color[1], color[2], 1.0);
            for (const direction of directions) {
                const dx = direction[0], dy = direction[1], dz = direction[2];
                let lx = graphLights ? viewMatrixScratch[0] * dx + viewMatrixScratch[4] * dy + viewMatrixScratch[8] * dz : dx;
                let ly = graphLights ? viewMatrixScratch[1] * dx + viewMatrixScratch[5] * dy + viewMatrixScratch[9] * dz : dy;
                let lz = graphLights ? viewMatrixScratch[2] * dx + viewMatrixScratch[6] * dy + viewMatrixScratch[10] * dz : dz;
                const length = Math.hypot(lx, ly, lz);
                lx /= length; ly /= length; lz /= length;
                offs += fillVec4(mappedF32, offs, lx, ly, lz, 0.0);
            }
            const ambient = graphLights ? this.drawCall.stadiumAmbientColor : [100 / 255, 100 / 255, 100 / 255];
            offs += fillVec4(mappedF32, offs, ambient[0], ambient[1], ambient[2], 1.0);
        }

        offs = renderInst.allocateUniformBuffer(F3DEX_Program.ub_CombineParams, (this.drawMatrices.length * 2 + 1) * 4);
        const comb = renderInst.mapUniformBufferF32(F3DEX_Program.ub_CombineParams);

        for (let i = 0; i < this.drawMatrices.length; i++) {
            vec4.copy(colorScratch, this.instancePrimColorOverrides[i] ?? this.primColorOverride ?? this.drawCall.DP_PrimColor);
            offs += fillVec4v(comb, offs, colorScratch);
        }
        for (let i = 0; i < this.drawMatrices.length; i++) {
            vec4.copy(colorScratch, this.instanceEnvColorOverrides[i] ?? this.envColorOverride ?? this.drawCall.DP_EnvColor);
            offs += fillVec4v(comb, offs, colorScratch);
        }

        this.fillExtraCombine(offs, comb);

        const modelTint = renderInst.allocateUniformBufferF32(DrawCallInstance.ub_ModelTint, 4);
        fillVec4v(modelTint, 0, this.modelTint);

        renderInstManager.submitRenderInst(renderInst);
    }

    protected fillExtraCombine(offs: number, comb: Float32Array): number {
        let primLOD = this.modelPrimLOD ?? this.drawCall.DP_PrimLOD;
        fillVec4(comb, offs, primLOD);
        return 1;
    }

    protected programConstructor(otherH: number, otherL: number, combine: RDP.CombineParams, alpha: number, tiles: RDP.TileState[]): F3DEX_Program {
        const lightCount = this.stadiumLayer >= 0 && this.parameterizedLighting
            ? (this.drawCall.stadiumLightColors.length !== 0 ? this.drawCall.stadiumLightColors.length : 2) : 0;
        return new F3DEX_Program(otherH, otherL, combine, alpha, tiles, lightCount);
    }
}
