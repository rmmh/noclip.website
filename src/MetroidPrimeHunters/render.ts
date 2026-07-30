
import { mat4, mat2d, ReadonlyVec3, vec3, vec4 } from "gl-matrix";
import { GfxFormat, GfxDevice, GfxProgram, GfxBindingLayoutDescriptor, GfxTexture, GfxBlendMode, GfxBlendFactor, GfxMipFilterMode, GfxTexFilterMode, GfxSampler, GfxMegaStateDescriptor, makeTextureDescriptor2D, GfxWrapMode, GfxCullMode } from '../gfx/platform/GfxPlatform.js';
import * as Viewer from '../viewer.js';
import * as NITRO_GX from '../SuperMario64DS/nitro_gx.js';
import { readTexture, getFormatName, Texture, textureFormatIsTranslucent } from "../SuperMario64DS/nitro_tex.js";
import { fillNITROFogParams, NITROFogConfig, NITRO_Program, VertexData } from '../SuperMario64DS/render.js';
import { GfxRenderInstManager, GfxRenderInst, GfxRendererLayer, makeSortKeyOpaque } from "../gfx/render/GfxRenderInstManager.js";
import { TextureMapping } from "../TextureHolder.js";
import { fillMatrix4x3, fillMatrix4x4, fillMatrix3x2, fillColor, fillVec4, fillVec4v } from "../gfx/helpers/UniformBufferHelpers.js";
import { computeViewMatrix } from "../Camera.js";
import AnimationController from "../AnimationController.js";
import { bindMPHMaterial, bindMPHT, MPHAnimation, MPHMaterialAnimation, MPHMaterialAnimator, MPHNodeAnimation, MPHNodeAnimator, MPHTexCoordAnimator } from "./mph_anim.js";
import { nArray, assertExists } from "../util.js";
import { TEX0Texture, PAT0TexAnimator, TEX0, expand5to8 } from "../nns_g3d/NNS_G3D.js";
import { setAttachmentStateSimple } from "../gfx/helpers/GfxMegaStateDescriptorHelpers.js";
import { MPHbin, MPHMaterial, MPHNode, MPHShape } from "./mph_binModel.js";
import { CalcBillboardFlags, Vec3Zero, calcBillboardMatrix, computeModelMatrixSRT } from "../MathHelpers.js";
import { GfxRenderCache } from "../gfx/render/GfxRenderCache.js";
import { Color, White, colorNewCopy } from "../Color.js";
import { MPHCollisionData, MPHCollisionPortal } from "./mph_collision.js";

function translateWrapMode(repeat: boolean, flip: boolean): GfxWrapMode {
    if (flip)
        return GfxWrapMode.Mirror;
    else if (repeat)
        return GfxWrapMode.Repeat;
    else
        return GfxWrapMode.Clamp;
}

function parseMPHTexImageParamWrapModeS(w0: number): GfxWrapMode {
    const repeatS = (((w0 >> 0) & 0x01) === 0x1);
    const flipS = (((w0 >> 1) & 0x01) === 0x1);
    return translateWrapMode(repeatS, flipS);
}

function parseMPHTexImageParamWrapModeT(w0: number): GfxWrapMode {
    const repeatT = (((w0 >> 8) & 0x01) === 0x1);
    const flipT = (((w0 >> 9) & 0x01) === 0x1);
    return translateWrapMode(repeatT, flipT);
}

const scratchTexMatrix = mat2d.create();
class MPHProgram extends NITRO_Program {
    public override vert = new NITRO_Program().vert
        .replace('    v_Color = a_Color;', '    v_Color = a_Color;\n    v_Color.a *= u_Misc[2].w;');
}

export type MPHFogConfig = NITROFogConfig;

class MaterialInstance {
    private texture: TEX0Texture | null;
    private gfxTextures: GfxTexture[] = [];
    private textureNames: string[] = [];
    private gfxSampler: GfxSampler | null = null;
    private textureMappings: TextureMapping[] = nArray(1, () => new TextureMapping());
    public viewerTextures: Viewer.Texture[] = [];
    public baseCtx: NITRO_GX.Context;
    public pat0Animator: PAT0TexAnimator | null = null;
    private sortKey: number;
    private megaStateFlags: Partial<GfxMegaStateDescriptor>;
    public lightMask = 0x0F;
    public diffuseColor = colorNewCopy(White);
    public ambientColor = colorNewCopy(White);
    public specularColor = colorNewCopy(White);
    public emissionColor = colorNewCopy(White);
    public fogEnabled = true;

    constructor(cache: GfxRenderCache, tex0: TEX0, public material: MPHMaterial, private texCoordAnimator: MPHTexCoordAnimator | null, private materialAnimators: readonly (MPHMaterialAnimator | null)[], private selectMaterialAnimation: MPHRendererOptions['selectMaterialAnimation'], private modifyMaterialColor: MPHRendererOptions['modifyMaterialColor'], entityModel: boolean, forceTwoSided: boolean, private fog: MPHFogConfig | null) {
        const device = cache.device;
        const texData = tex0.textures.find((t) => t.name === this.material.textureName);
        this.texture = texData !== undefined ? texData: null;
        this.translateTexture(device, tex0, this.material.textureName, this.material.paletteName, entityModel);
        // ApplyMaterialAnimation @ 0x02052200 overwrites the copied material's
        // alpha before drawing. Keep animated material alpha out of the baked
        // vertex colors so the per-frame shader value can replace it.
        const hasMaterialAnimation = this.materialAnimators.some((animator) => animator !== null);
        this.baseCtx = { color: White, alpha: hasMaterialAnimation ? 0xFF : expand5to8(this.material.alpha) };
        if (entityModel) {
            this.diffuseColor = colorNewCopy(this.material.diffuseColor);
            this.ambientColor = colorNewCopy(this.material.ambientColor);
            this.specularColor = colorNewCopy(this.material.specularColor);
            this.lightMask = this.material.lightingEnabled ? 0x03 : 0;
            if (this.material.lightingEnabled)
                this.emissionColor.r = this.emissionColor.g = this.emissionColor.b = 0;
        }

        if (this.gfxTextures.length > 0) {
            this.gfxSampler = cache.createSampler({
                minFilter: GfxTexFilterMode.Point,
                magFilter: GfxTexFilterMode.Point,
                mipFilter: GfxMipFilterMode.Nearest,
                wrapS: parseMPHTexImageParamWrapModeS(this.material.texParams),
                wrapT: parseMPHTexImageParamWrapModeT(this.material.texParams),
                minLOD: 0,
                maxLOD: 100,
            });

            const textureMapping = this.textureMappings[0];
            textureMapping.gfxTexture = this.gfxTextures[0];
            textureMapping.gfxSampler = this.gfxSampler;
        }

        // NITRO's Rendering Engine uses two passes. Opaque, then Transparent.
        // A transparent polygon is one that has an alpha of < 0xFF, or uses
        // A5I3 / A3I5 textures.
        const isTranslucent = (this.material.alpha < 0x1F) || (this.texture && textureFormatIsTranslucent(this.texture.format));
        const xl = !!((this.material.polyAttribs >>> 11) & 0x01);
        const depthWrite = xl || !isTranslucent;

        const layer = isTranslucent ? GfxRendererLayer.TRANSLUCENT : GfxRendererLayer.OPAQUE;
        this.sortKey = makeSortKeyOpaque(layer, 0);
        this.megaStateFlags = {
            depthWrite: depthWrite,
            cullMode: forceTwoSided ? GfxCullMode.None : this.material.cullMode,
        };

        setAttachmentStateSimple(this.megaStateFlags, {
            blendMode: GfxBlendMode.Add,
            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
            blendSrcFactor: GfxBlendFactor.SrcAlpha,
        });
    }

    private translateTexture(device: GfxDevice, tex0: TEX0 | null, textureName: string | null, paletteName: string | null, entityModel: boolean) {
        if (textureName === null) {
            if (!entityModel)
                return;
            const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, 1, 1, 1));
            device.uploadTextureData(gfxTexture, 0, [new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF])]);
            this.gfxTextures.push(gfxTexture);
            this.textureNames.push('(untextured)');
            return;
        }
        if (tex0 === null)
            return;

        const texture = assertExists(tex0.textures.find((t) => t.name === textureName));
        const palette = paletteName !== null ? assertExists(tex0.palettes.find((t) => t.name === paletteName)) : null;
        const fullTextureName = `${textureName}/${paletteName}`;
        if (this.textureNames.indexOf(fullTextureName) >= 0)
            return;
        this.textureNames.push(fullTextureName);

        const inTexture: Texture = { ...texture, palData: palette !== null ? palette.data : null } as Texture;
        const pixels = readTexture(inTexture);
        const gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, texture.width, texture.height, 1));
        this.gfxTextures.push(gfxTexture);

        device.uploadTextureData(gfxTexture, 0, [pixels]);

        const extraInfo = new Map<string, string>();
        extraInfo.set('Format', getFormatName(texture.format));
        this.viewerTextures.push({ gfxTexture, extraInfo });
    }

    public setOnRenderInst(template: GfxRenderInst, viewerInput: Viewer.ViewerRenderInput, alphaMultiplier: number = 1, forceTranslucent: boolean = false): void {
        const materialAnimationIndex = this.selectMaterialAnimation?.(viewerInput.time) ?? 0;
        const materialAnimator = this.materialAnimators[materialAnimationIndex] ?? null;
        if (materialAnimator !== null) {
            const animatedAlpha = materialAnimator.calcColors(this.diffuseColor, this.ambientColor, this.specularColor);
            alphaMultiplier *= animatedAlpha;
            forceTranslucent ||= animatedAlpha < 1;
            // RenderModelMaterial @ 0x02045B04 requests that MATERIAL_COLOR0
            // also set the current vertex color. With lighting disabled, MPH
            // therefore displays the animated diffuse color directly.
            if (this.lightMask === 0) {
                this.emissionColor.r = this.diffuseColor.r;
                this.emissionColor.g = this.diffuseColor.g;
                this.emissionColor.b = this.diffuseColor.b;
            }
        }
        this.modifyMaterialColor?.(this.diffuseColor, this.material.name, viewerInput.time);
        if (this.modifyMaterialColor !== undefined && this.lightMask === 0) {
            this.emissionColor.r = this.diffuseColor.r;
            this.emissionColor.g = this.diffuseColor.g;
            this.emissionColor.b = this.diffuseColor.b;
        }

        if (this.texCoordAnimator !== null) {
            this.texCoordAnimator.calcTexMtx(scratchTexMatrix, this.material.texScaleS, this.material.texScaleT);
        } else {
            mat2d.copy(scratchTexMatrix, this.material.texMatrix);
        }

        template.sortKey = forceTranslucent ? makeSortKeyOpaque(GfxRendererLayer.TRANSLUCENT, 0) : this.sortKey;
        template.setMegaStateFlags(forceTranslucent ? { ...this.megaStateFlags, depthWrite: false } : this.megaStateFlags);

        if (this.pat0Animator !== null) {
            const fullTextureName = this.pat0Animator.calcFullTextureName();
            let textureIndex = this.textureNames.indexOf(fullTextureName);
            if (textureIndex >= 0)
                this.textureMappings[0].gfxTexture = this.gfxTextures[textureIndex];
        }

        template.setSamplerBindingsFromTextureMappings(this.textureMappings);

        let offs = template.allocateUniformBuffer(NITRO_Program.ub_MaterialParams, NITRO_Program.ub_MaterialParamsWordCount);
        const materialParamsMapped = template.mapUniformBufferF32(NITRO_Program.ub_MaterialParams);
        offs += fillMatrix3x2(materialParamsMapped, offs, scratchTexMatrix);
        offs += fillColor(materialParamsMapped, offs, this.diffuseColor, 0);
        offs += fillColor(materialParamsMapped, offs, this.ambientColor, this.lightMask);
        offs += fillColor(materialParamsMapped, offs, this.specularColor, alphaMultiplier);
        offs += fillColor(materialParamsMapped, offs, this.emissionColor);
        offs += fillNITROFogParams(materialParamsMapped, offs, this.fog, this.fogEnabled);
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.gfxTextures.length; i++)
            device.destroyTexture(this.gfxTextures[i]);
    }
}

class Node {
    public modelMatrix = mat4.create();
    public drawMatrix = mat4.create();
    public parent: Node | null = null;
    public billboardMode: BillboardMode;
    private localMatrix = mat4.create();
    private bindMatrix = mat4.create();

    constructor(public node: MPHNode, public index: number) {
        this.billboardMode = node.billboardType;
        computeModelMatrixSRT(this.bindMatrix,
            node.scale[0], node.scale[1], node.scale[2],
            node.rotation[0], node.rotation[1], node.rotation[2],
            node.translation[0], node.translation[1], node.translation[2]);
    }

    public calcMatrix(baseModelMatrix: mat4, viewMatrix: mat4, nodeAnimator: MPHNodeAnimator | null, timeInMilliseconds: number, modifyNodeMatrix: MPHRendererOptions['modifyNodeMatrix']): void {
        if (nodeAnimator !== null)
            nodeAnimator.calcNodeMatrix(this.localMatrix, this.index);
        else
            mat4.copy(this.localMatrix, this.bindMatrix);
        modifyNodeMatrix?.(this.localMatrix, this.node.name, timeInMilliseconds);
        mat4.mul(this.modelMatrix, this.parent !== null ? this.parent.modelMatrix : baseModelMatrix, this.localMatrix);

        mat4.mul(this.drawMatrix, viewMatrix, this.modelMatrix);
        if (this.billboardMode === BillboardMode.BB)
            calcBillboardMatrix(this.drawMatrix, this.drawMatrix, CalcBillboardFlags.UseRollLocal | CalcBillboardFlags.PriorityZ | CalcBillboardFlags.UseZPlane);
        else if (this.billboardMode === BillboardMode.BBY)
            calcBillboardMatrix(this.drawMatrix, this.drawMatrix, CalcBillboardFlags.UseRollLocal | CalcBillboardFlags.PriorityY | CalcBillboardFlags.UseZPlane);
        else if (this.billboardMode === BillboardMode.PARTICLE)
            calcAxialParticleBillboardMatrix(this.drawMatrix);
    }
}

const scratchParticleAxis = vec3.create();
const scratchParticleNormal = vec3.create();
const scratchParticleCross = vec3.create();

function calcAxialParticleBillboardMatrix(dst: mat4): void {
    const scaleX = Math.hypot(dst[0], dst[1], dst[2]);
    const scaleY = Math.hypot(dst[4], dst[5], dst[6]);
    const scaleZ = Math.hypot(dst[8], dst[9], dst[10]);

    // Keep particles parallel to nozzle axis
    vec3.set(scratchParticleAxis, dst[8], dst[9], dst[10]);
    vec3.normalize(scratchParticleAxis, scratchParticleAxis);
    vec3.set(scratchParticleNormal, -dst[12], -dst[13], -dst[14]);
    vec3.scaleAndAdd(scratchParticleNormal, scratchParticleNormal, scratchParticleAxis, -vec3.dot(scratchParticleNormal, scratchParticleAxis));
    if (vec3.squaredLength(scratchParticleNormal) < 0.000001) {
        vec3.set(scratchParticleNormal, dst[4], dst[5], dst[6]);
        vec3.scaleAndAdd(scratchParticleNormal, scratchParticleNormal, scratchParticleAxis, -vec3.dot(scratchParticleNormal, scratchParticleAxis));
    }
    vec3.normalize(scratchParticleNormal, scratchParticleNormal);
    vec3.cross(scratchParticleCross, scratchParticleNormal, scratchParticleAxis);
    vec3.normalize(scratchParticleCross, scratchParticleCross);

    dst[0] = scratchParticleCross[0] * scaleX;
    dst[1] = scratchParticleCross[1] * scaleX;
    dst[2] = scratchParticleCross[2] * scaleX;
    dst[4] = scratchParticleNormal[0] * scaleY;
    dst[5] = scratchParticleNormal[1] * scaleY;
    dst[6] = scratchParticleNormal[2] * scaleY;
    dst[8] = scratchParticleAxis[0] * scaleZ;
    dst[9] = scratchParticleAxis[1] * scaleZ;
    dst[10] = scratchParticleAxis[2] * scaleZ;
}

const scratchViewMatrix = mat4.create();
const scratchRootMatrix = mat4.create();
const scratchLightDirection = vec4.create();
const scratchLightViewMatrix = mat4.create();
const MAX_MATRICES = 32;
class ShapeInstance {
    private vertexData: VertexData;
    private matrixNodes: Node[] = [];

    constructor(cache: GfxRenderCache, private materialInstance: MaterialInstance, public node: Node, public shape: MPHShape, matrixNodes: Map<number, Node>, numMatrices: number, private portal: MPHCollisionPortal | null = null) {
        const baseCtx = this.materialInstance.baseCtx;
        for (let i = 0; i < numMatrices; i++)
            this.matrixNodes.push(matrixNodes.get(i) ?? node);
        this.vertexData = new VertexData(cache, NITRO_GX.readCmds(shape.dlBuffer, baseCtx, 1));
    }

    private calcPortalAlphaMultiplier(viewerInput: Viewer.ViewerRenderInput): number {
        if (this.portal === null || this.portal.centroid === null)
            return 1;

        const cameraMatrix = viewerInput.camera.worldMatrix;
        const distance = Math.hypot(
            cameraMatrix[12] - this.portal.centroid[0],
            cameraMatrix[13] - this.portal.centroid[1],
            cameraMatrix[14] - this.portal.centroid[2],
        );

        return Math.min(distance * 4, 31) / 31;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        const renderInst = renderInstManager.newRenderInst();
        renderInst.setVertexInput(this.vertexData.inputLayout, this.vertexData.vertexBufferDescriptors, this.vertexData.indexBufferDescriptor);

        let offs = renderInst.allocateUniformBuffer(NITRO_Program.ub_DrawParams, 12*MAX_MATRICES);
        const drawParamsMapped = renderInst.mapUniformBufferF32(NITRO_Program.ub_DrawParams);

        for (let i = 0; i < this.matrixNodes.length; i++)
            offs += fillMatrix4x3(drawParamsMapped, offs, this.matrixNodes[i].drawMatrix);

        const alphaMultiplier = this.calcPortalAlphaMultiplier(viewerInput);
        const forceTranslucent = this.portal !== null && alphaMultiplier < 1;
        this.materialInstance.setOnRenderInst(renderInst, viewerInput, alphaMultiplier, forceTranslucent);

        const drawCall = this.vertexData.nitroVertexData.drawCall;
        renderInst.setDrawCount(drawCall.numIndices, drawCall.startIndex);
        renderInstManager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice): void {
        this.vertexData.destroy(device);
    }
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 3, numSamplers: 1 }];

enum BillboardMode {
    NONE, BB, BBY, PARTICLE,
}

export type MPHSceneMode =
    { kind: 'singlePlayer', geometrySet: number } |
    { kind: 'multiplayer', layout: 0 | 1, captureTheFlag?: boolean };

export interface MPHLighting {
    colors: readonly [ReadonlyVec3, ReadonlyVec3];
    directions: readonly [ReadonlyVec3, ReadonlyVec3];
}

export interface MPHRendererOptions {
    sceneMode?: MPHSceneMode;
    entityModel?: boolean;
    lighting?: MPHLighting;
    isVisibleAtTime?: (timeInMilliseconds: number) => boolean;
    mapAnimationTime?: (timeInMilliseconds: number) => number;
    mapMaterialAnimationTime?: (timeInMilliseconds: number) => number;
    additionalNodeAnimations?: (MPHNodeAnimation | null)[];
    additionalMaterialAnimations?: (MPHMaterialAnimation | null)[];
    selectNodeAnimation?: (timeInMilliseconds: number) => number;
    selectMaterialAnimation?: (timeInMilliseconds: number) => number;
    modifyMaterialColor?: (dst: Color, materialName: string, timeInMilliseconds: number) => void;
    modifyNodeMatrix?: (dst: mat4, nodeName: string, timeInMilliseconds: number) => void;
    nodeFilter?: (name: string) => boolean;
    forceBillboard?: boolean;
    forceTwoSided?: boolean;
    fog?: MPHFogConfig | null;
    collision?: MPHCollisionData | null;
    sceneTransform?: mat4;
}

function nodeIsVisibleInMode(name: string, mode: MPHSceneMode): boolean {
    let hasModeTag = false;
    let matchesMode = false;

    // FilterModelNodesByGameModeTags @ 0x0211B004:
    // check consecutive four-byte tags at the beginning of each node name.
    for (let offs = 0; name.charAt(offs) === '_'; offs += 4) {
        hasModeTag = true;
        const tag = name.slice(offs, offs + 4).toLowerCase();
        if (tag.startsWith('_s')) {
            const geometrySet = Number.parseInt(tag.slice(2), 10);
            matchesMode ||= mode.kind === 'singlePlayer' && geometrySet === mode.geometrySet;
        } else if (tag === '_mpu') {
            matchesMode ||= mode.kind === 'multiplayer';
        } else if (tag === '_ml0') {
            matchesMode ||= mode.kind === 'multiplayer' && mode.layout === 0;
        } else if (tag === '_ml1') {
            matchesMode ||= mode.kind === 'multiplayer' && mode.layout === 1;
        } else if (tag === '_ctf') {
            matchesMode ||= mode.kind === 'multiplayer' && mode.captureTheFlag === true;
        }
    }

    return !hasModeTag || matchesMode;
}

export class MPHRenderer {
    public modelMatrix = mat4.create();
    public isSkybox: boolean = false;
    public visible: boolean = true;
    public animationController = new AnimationController();
    private materialAnimationController = new AnimationController();

    private gfxProgram: GfxProgram;
    private materialInstances: MaterialInstance[] = [];
    private shapeInstances: ShapeInstance[] = [];
    private nodes: Node[] = [];
    public modelScale: number;
    private nodeDrawOrder: Node[] = [];
    private nodeAnimator: MPHNodeAnimator | null;
    private nodeAnimators: (MPHNodeAnimator | null)[];
    private selectNodeAnimation: MPHRendererOptions['selectNodeAnimation'];
    private modifyNodeMatrix: MPHRendererOptions['modifyNodeMatrix'];
    private sceneMode: MPHSceneMode;
    private lighting: MPHLighting | undefined;
    private isVisibleAtTime: MPHRendererOptions['isVisibleAtTime'];
    private mapAnimationTime: MPHRendererOptions['mapAnimationTime'];
    private mapMaterialAnimationTime: MPHRendererOptions['mapMaterialAnimationTime'];
    private sceneTransform: mat4 | null;
    public viewerTextures: Viewer.Texture[] = [];

    public getNodeModelMatrix(name: string): mat4 | null {
        for (const node of this.nodes)
            if (node.node.name === name)
                return node.modelMatrix;
        return null;
    }

    constructor(device: GfxDevice, cache: GfxRenderCache, public mphModel: MPHbin, private tex0: TEX0, mphAnimation: MPHAnimation | null, options: MPHRendererOptions) {
        this.sceneMode = options.sceneMode ?? { kind: 'singlePlayer', geometrySet: 1 };
        this.lighting = options.lighting;
        this.isVisibleAtTime = options.isVisibleAtTime;
        this.mapAnimationTime = options.mapAnimationTime;
        this.mapMaterialAnimationTime = options.mapMaterialAnimationTime;
        this.selectNodeAnimation = options.selectNodeAnimation;
        this.modifyNodeMatrix = options.modifyNodeMatrix;
        this.sceneTransform = options.sceneTransform !== undefined ? mat4.clone(options.sceneTransform) : null;
        const entityModel = options.entityModel ?? false;
        const collision = options.collision ?? null;
        const program = new MPHProgram();
        program.defines.set('USE_VERTEX_COLOR', '1');
        program.defines.set('USE_TEXTURE', '1');
        program.defines.set('USE_FOG', '1');
        this.gfxProgram = cache.createProgram(program);
        const nodeAnimation = mphAnimation?.node ?? null;
        this.nodeAnimator = nodeAnimation !== null ? new MPHNodeAnimator(this.animationController, nodeAnimation) : null;
        this.nodeAnimators = [this.nodeAnimator];
        for (const animation of options.additionalNodeAnimations ?? [])
            this.nodeAnimators.push(animation !== null ? new MPHNodeAnimator(this.animationController, animation) : null);
        this.modelScale = mphModel.posScale * (1 << mphModel.scaleFactor);
        mat4.fromScaling(this.modelMatrix, [this.modelScale, this.modelScale, this.modelScale]);

        const texCoordAnimation = mphAnimation?.texCoord ?? null;
        const materialAnimations = [
            mphAnimation?.material ?? null,
            ...(options.additionalMaterialAnimations ?? []),
        ];

        for (let i = 0; i < mphModel.materials.length; i++) {
            const material = mphModel.materials[i];
            const texCoordAnimator = texCoordAnimation !== null ?
                bindMPHT(this.animationController, texCoordAnimation, material.name) : null;
            const materialAnimators = materialAnimations.map((animation) =>
                animation !== null ? bindMPHMaterial(this.materialAnimationController, animation, material.name) : null);
            this.materialInstances.push(new MaterialInstance(cache, this.tex0, material, texCoordAnimator, materialAnimators, options.selectMaterialAnimation, options.modifyMaterialColor, entityModel, options.forceTwoSided === true, options.fog ?? null));
        }

        for (let i = 0; i < mphModel.nodes.length; i++) {
            const node = new Node(mphModel.nodes[i], i);
            if (options.forceBillboard === true)
                node.billboardMode = BillboardMode.PARTICLE;
            this.nodes.push(node);
        }
        const addNodeDrawOrder = (index: number, parent: Node | null): void => {
            for (let i = index; i !== -1; i = mphModel.nodes[i].next) {
                const node = this.nodes[i];
                node.parent = parent;
                this.nodeDrawOrder.push(node);
                addNodeDrawOrder(mphModel.nodes[i].child, node);
            }
        };
        if (this.nodes.length !== 0)
            addNodeDrawOrder(0, null);

        const numMatrices = Math.min(Math.max(mphModel.matrixCount, 1), MAX_MATRICES);
        const drawnNodes = new Set(this.nodeDrawOrder);
        const matrixNodes = new Map<number, Node>();
        for (let i = 0; i < mphModel.matrixNodeIndices.length; i++) {
            const node = this.nodes[mphModel.matrixNodeIndices[i]];
            if (mphModel.matrixBlendCounts[i] < 2 && drawnNodes.has(node))
                matrixNodes.set(i, node);
        }

        for (let i = 0; i < this.materialInstances.length; i++)
            if (this.materialInstances[i].viewerTextures.length > 0)
                this.viewerTextures.push(this.materialInstances[i].viewerTextures[0]);

        const portalsByNode = new Map<string, MPHCollisionPortal>();
        for (const portal of collision?.portals ?? [])
            if (portal.geometryNodeName !== null)
                portalsByNode.set(portal.geometryNodeName, portal);

        for (const node of this.nodeDrawOrder) {
            if (options.nodeFilter !== undefined && !options.nodeFilter(node.node.name))
                continue;
            if (!nodeIsVisibleInMode(node.node.name, this.sceneMode))
                continue;

            for (let j = 0; j < node.node.meshCount; j++) {
                const mesh = mphModel.meshs[node.node.meshStart + j];
                const shape = mphModel.shapes[mesh.shapeID];
                const portal = node.parent !== null ? portalsByNode.get(node.parent.node.name) ?? null : null;
                this.shapeInstances.push(new ShapeInstance(cache, this.materialInstances[mesh.matID], node, shape, matrixNodes, numMatrices, portal));
            }
        }
    }

    public setFogEnabled(enabled: boolean): void {
        for (const material of this.materialInstances)
            material.fogEnabled = enabled;
    }

    public prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible || (this.isVisibleAtTime !== undefined && !this.isVisibleAtTime(viewerInput.time)))
            return;
        this.animationController.setTimeInMilliseconds(this.mapAnimationTime !== undefined ?
            this.mapAnimationTime(viewerInput.time) : viewerInput.time);
        this.materialAnimationController.setTimeInMilliseconds(this.mapMaterialAnimationTime !== undefined ?
            this.mapMaterialAnimationTime(viewerInput.time) :
            this.mapAnimationTime !== undefined ? this.mapAnimationTime(viewerInput.time) : viewerInput.time);
        if (this.selectNodeAnimation !== undefined)
            this.nodeAnimator = this.nodeAnimators[this.selectNodeAnimation(viewerInput.time)] ?? null;
        computeViewMatrix(scratchViewMatrix, viewerInput.camera);
        if (this.sceneTransform !== null)
            mat4.mul(scratchRootMatrix, this.sceneTransform, this.modelMatrix);
        else
            mat4.copy(scratchRootMatrix, this.modelMatrix);
        for (const node of this.nodeDrawOrder)
            node.calcMatrix(scratchRootMatrix, scratchViewMatrix, this.nodeAnimator, viewerInput.time, this.modifyNodeMatrix);

        const template = renderInstManager.pushTemplate();
        template.setBindingLayouts(bindingLayouts);
        template.setGfxProgram(this.gfxProgram);

        let offs = template.allocateUniformBuffer(NITRO_Program.ub_SceneParams, 16+32);
        const sceneParamsMapped = template.mapUniformBufferF32(NITRO_Program.ub_SceneParams);
        offs += fillMatrix4x4(sceneParamsMapped, offs, viewerInput.camera.projectionMatrix);
        computeViewMatrix(scratchLightViewMatrix, viewerInput.camera);
        for (let i = 0; i < 4; i++) {
            const source = this.lighting?.directions[i];
            if (source !== undefined) {
                vec4.set(scratchLightDirection, source[0], source[1], source[2], 0);
                if (this.sceneTransform !== null)
                    vec4.transformMat4(scratchLightDirection, scratchLightDirection, this.sceneTransform);
                vec4.transformMat4(scratchLightDirection, scratchLightDirection, scratchLightViewMatrix);
            } else {
                vec4.zero(scratchLightDirection);
            }
            offs += fillVec4v(sceneParamsMapped, offs, scratchLightDirection);
        }
        for (let i = 0; i < 4; i++) {
            const color = this.lighting?.colors[i] ?? Vec3Zero;
            offs += fillVec4(sceneParamsMapped, offs, color[0], color[1], color[2], 1);
        }
        for (let i = 0; i < this.shapeInstances.length; i++)
            this.shapeInstances[i].prepareToRender(renderInstManager, viewerInput);

        renderInstManager.popTemplate();
    }

    public destroy(device: GfxDevice): void {
        for (let i = 0; i < this.materialInstances.length; i++)
            this.materialInstances[i].destroy(device);
        for (let i = 0; i < this.shapeInstances.length; i++)
            this.shapeInstances[i].destroy(device);
    }
}
