import { mat4 } from 'gl-matrix';
import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { RSPSharedOutput } from '../BanjoKazooie/f3dex.js';
import * as RDP from '../Common/N64/RDP.js';
import { MoveEffectArchive, MoveEffectParticleSpawn } from './effects.js';
import * as F3DEX2 from './F3DEX2.js';
import { MoveEffectTextureDataMap } from './archive.js';
import { makeMoveEffectGeometry } from './move_effect_geometry.js';
import {
    dualTextureColorAndAlphaCombine, dualTextureColorOnlyCombine, noisyParticlePrimitiveEnvironmentCombine,
    particlePrimitiveEnvironmentCombine,
    setCombineTuple, setMaterialCombine, texturedPrimitiveEnvironmentShadeCombine,
} from './materials.js';
import { moveEffectEmissionCount } from './move_effect_timing.js';

export interface CompiledParticleEffects {
    Outputs: F3DEX2.RSPOutput[];
    Matrices: mat4[][];
    Descriptors: { DescriptorIndex: number; ArchiveID: number }[];
}

export function compileParticleEffects(sharedOutput: RSPSharedOutput,
                                       moveEffectArchive: MoveEffectArchive, activeSpawns: readonly MoveEffectParticleSpawn[],
                                       activeResourceKeys: ReadonlySet<string>): CompiledParticleEffects {
    const outputs: F3DEX2.RSPOutput[] = [];
    const matrices: mat4[][] = [];
    const sourceDescriptors: CompiledParticleEffects['Descriptors'] = [];
    const metadata = moveEffectArchive.MoveEffects;

    const descriptorCapacity = metadata.RenderDescriptors.map((_, descriptorIndex) => {
        let capacity = 1;
        for (const spawn of activeSpawns) {
            const style = metadata.ParticleStyles[spawn.ParticleStyle];
            if (style === undefined || style.RenderDescriptor !== descriptorIndex) continue;
            const repetitions = moveEffectEmissionCount(spawn);
            capacity = Math.max(capacity, Math.min(64, Math.max(1, spawn.BurstCount) * repetitions));
        }
        return capacity;
    });
    for (let descriptorIndex = 0; descriptorIndex < metadata.RenderDescriptors.length; descriptorIndex++) {
        const descriptor = metadata.RenderDescriptors[descriptorIndex];
        for (const resource of metadata.Resources) {
            if (resource.ResourceID !== descriptor.ResourceID || resource.Type !== 1) continue;
            if (!activeResourceKeys.has(`${resource.ArchiveID}:${resource.ResourceID}`)) continue;
            const bank = moveEffectArchive.MoveEffectResourceBanks[resource.ArchiveID];
            if (bank === undefined) continue;
            const archivedGeometry = descriptor.GeometryResourceID < 0 ? undefined : metadata.Resources.find((candidate) =>
                candidate.ArchiveID === resource.ArchiveID && candidate.ResourceID === descriptor.GeometryResourceID && candidate.Type === 2);
            if (descriptor.GeometryResourceID >= 0 && archivedGeometry === undefined) continue;
            const geometry = archivedGeometry === undefined ? makeMoveEffectGeometry(descriptor.GeometryKind) : null;
            const state = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data,
                geometry?.Data ?? new ArrayBufferSlice(new ArrayBuffer(0)), bank.ArchiveID));
            state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE | F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
            state.gDPSetOtherModeH(20, 2, 0);
            const renderMode = descriptor.RenderFunction === 0x304AC ? RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF2 :
                descriptor.RenderFunction === 0x30388 ? RDP.RENDER_MODES.G_RM_AA_ZB_XLU_SURF2 : RDP.RENDER_MODES.G_RM_AA_XLU_SURF2;
            state.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_PASS | renderMode);
            // Most descriptor render callbacks call set_particle_primitive_environment_combine. The
            // primitive-only render_primitive_colored_particle is ordinary G_CC_MODULATEIA.
            if (descriptor.DualTextureMode === 'colorAndAlpha')
                setCombineTuple(state, dualTextureColorAndAlphaCombine);
            else if (descriptor.DualTextureMode === 'colorOnly') {
                setCombineTuple(state, dualTextureColorOnlyCombine);
                state.setDualTextureParticleColorCombine();
            }
            else if (descriptor.RenderFunction === 0x30388)
                setCombineTuple(state, texturedPrimitiveEnvironmentShadeCombine);
            else if (descriptor.RenderFunction === 0x304AC) {
                setMaterialCombine(state, 4);
                state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_CULL_BACK | F3DEX2.RSP_Geometry.G_LIGHTING);
            }
            else if (descriptor.RenderFunction === 0x140CB90 || descriptor.RenderFunction === 0x140CE68)
                setMaterialCombine(state, 4);
            else if (descriptor.RenderFunction === 0x140CF30)
                setCombineTuple(state, noisyParticlePrimitiveEnvironmentCombine);
            else
                setCombineTuple(state, particlePrimitiveEnvironmentCombine), state.setParticlePrimitiveEnvironmentCombine();
            state.gSPSetPrimColor(descriptor.DualTextureMode === 'none' ? 0 : 0x80, 0xFF, 0xFF, 0xFF, 0xFF);
            state.gSPSetEnvColor(0, 0, 0, 0xFF);
            state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
            const textureAddress = 0x0E000000 + resource.DataOffset;
            const bitsPerPixel = [4, 8, 16, 32][descriptor.TextureSize];
            const line = Math.ceil(descriptor.Width * bitsPerPixel / 64);
            const textureStride = descriptor.Width * descriptor.Height * bitsPerPixel >>> 3;
            const secondaryResource = descriptor.SecondaryResourceID < 0 ? undefined : metadata.Resources.find((candidate) =>
                candidate.ArchiveID === resource.ArchiveID && candidate.ResourceID === descriptor.SecondaryResourceID && candidate.Type === 1);
            if (descriptor.DualTextureMode !== 'none' && secondaryResource === undefined)
                throw new Error(`move effect ${resource.ArchiveID}:${descriptor.ResourceID} is missing secondary texture ${descriptor.SecondaryResourceID}`);
            const secondaryBitsPerPixel = [4, 8, 16, 32][descriptor.SecondaryTextureSize];
            const secondaryLine = Math.ceil(descriptor.SecondaryWidth * secondaryBitsPerPixel / 64);
            const loadSecondaryTexture = (): void => {
                if (secondaryResource === undefined) return;
                const address = 0x0E000000 + secondaryResource.DataOffset;
                state.registerTextureDescriptor(address, descriptor.SecondaryTextureFormat, descriptor.SecondaryTextureSize,
                    descriptor.SecondaryWidth, descriptor.SecondaryHeight);
                state.gDPSetTextureImage(descriptor.SecondaryTextureFormat, descriptor.SecondaryTextureSize, descriptor.SecondaryWidth, address);
                state.gDPSetTile(descriptor.SecondaryTextureFormat, descriptor.SecondaryTextureSize, 0, 0x100, 7, 0, 0, 0, 0, 0, 0, 0);
                state.gDPLoadBlock(7, 0, 0, descriptor.SecondaryWidth * descriptor.SecondaryHeight - 1, 0);
                const maskS = Math.log2(descriptor.SecondaryWidth), maskT = Math.log2(descriptor.SecondaryHeight);
                const shifts = descriptor.RenderFunction === 0x30300 || descriptor.RenderFunction === 0x30344 ? 2 :
                    descriptor.RenderFunction === 0x3079C ? 1 : 0;
                const shiftt = descriptor.RenderFunction === 0x30300 || descriptor.RenderFunction === 0x30344 ? 1 :
                    descriptor.RenderFunction === 0x3079C ? 0x0F : 0;
                const mirror = descriptor.RenderFunction === 0x3079C ? 1 : 0;
                state.gDPSetTile(descriptor.SecondaryTextureFormat, descriptor.SecondaryTextureSize, secondaryLine, 0x100, 1, 0,
                    mirror, maskT, shiftt, mirror, maskS, shifts);
                state.gDPSetTileSize(1, 0, 0, (descriptor.SecondaryWidth - 1) << 2, (descriptor.SecondaryHeight - 1) << 2);
            };
            const loadTextureFrame = (textureFrame: number): void => {
                const address = textureAddress + textureFrame * textureStride;
                state.registerTextureDescriptor(address, descriptor.TextureFormat, descriptor.TextureSize, descriptor.Width, descriptor.Height);
                state.gDPSetTextureImage(descriptor.TextureFormat, descriptor.TextureSize, descriptor.Width, address);
                state.gDPSetTile(descriptor.TextureFormat, descriptor.TextureSize, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
                state.gDPLoadBlock(7, 0, 0, descriptor.Width * descriptor.Height - 1, 0);
                const wrappingDualTexture = descriptor.RenderFunction === 0x30574 || descriptor.RenderFunction === 0x30688 ||
                    descriptor.RenderFunction === 0x3079C;
                const maskS = wrappingDualTexture ? Math.log2(descriptor.Width) : 0;
                const maskT = wrappingDualTexture ? Math.log2(descriptor.Height) : 0;
                const mirror = descriptor.RenderFunction === 0x3079C ? 1 : 0;
                const tileAddressMode = wrappingDualTexture ? mirror : 2;
                state.gDPSetTile(descriptor.TextureFormat, descriptor.TextureSize, line, 0, 0, 0,
                    tileAddressMode, maskT, 0, tileAddressMode, maskS, descriptor.RenderFunction === 0x3079C ? 2 : 0);
                state.gDPSetTileSize(0, 0, 0, (descriptor.Width - 1) << 2, (descriptor.Height - 1) << 2);
                loadSecondaryTexture();
            };
            const textureVariants: number[][] = [];
            for (let textureFrame = 0; textureFrame < descriptor.TextureFrameCount; textureFrame++) {
                loadTextureFrame(textureFrame);
                textureVariants.push(state.getCurrentTextureIndices());
            }
            loadTextureFrame(0);
            state.setTextureVariants(textureVariants);
            switch (descriptor.RenderFunction) {
                case 0x30300: case 0x30344: state.setTextureScrollSpeeds([[0, 0], [0, 10]]); break;
                case 0x30574: state.setTextureScrollSpeeds([[2, -2], [0, -1]]); break;
                case 0x30688: state.setTextureScrollSpeeds([[1, -3], [-2, -2]]); break;
                case 0x3079C: state.setTextureScrollSpeeds([[1, 1], [-1, 1]]); break;
            }
            const drawMatrices = Array.from({ length: descriptorCapacity[descriptorIndex] }, () => mat4.create());
            for (let instance = 0; instance < drawMatrices.length; instance++) {
                state.setMatrixIndex(instance);
                if (archivedGeometry !== undefined) {
                    F3DEX2.runDL_F3DEX2(state, 0x0E000000 + archivedGeometry.DataOffset);
                } else {
                    state.gSPVertex(0x0F000000, geometry!.VertexCount, 0);
                    for (const triangle of geometry!.Triangles)
                        state.gSPTri(triangle[0], triangle[1], triangle[2]);
                }
            }
            const output = state.finish();
            if (output === null) continue;
            outputs.push(output);
            matrices.push(drawMatrices);
            sourceDescriptors.push({ DescriptorIndex: descriptorIndex, ArchiveID: resource.ArchiveID });
        }
    }

    return { Outputs: outputs, Matrices: matrices, Descriptors: sourceDescriptors };
}
