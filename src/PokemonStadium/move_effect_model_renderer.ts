import { mat4 } from 'gl-matrix';
import { RSPSharedOutput } from '../BanjoKazooie/f3dex.js';
import { PokemonGeoNode, PokemonTextureDescriptor } from './archive.js';
import { MoveEffectArchive, MoveEffectParticleSpawn } from './effects.js';
import * as F3DEX2 from './F3DEX2.js';
import { MoveEffectTextureDataMap } from './archive.js';
import { setMaterialCombine, zBufferedRenderModes } from './materials.js';
import { PokemonModelPose } from './model_pose.js';
import { pokemonDrawCallback } from './draw_callbacks.js';

export interface CompiledMoveEffectModel {
    ArchiveID: number;
    ResourceID: number;
    AnimationResourceID: number;
    Output: F3DEX2.RSPOutput;
    FrameMatrices: mat4[][];
}

/** Compile fragment62's type-3 model resources used by gDefaultParticleStyle. */
export function compileMoveEffectModels(sharedOutput: RSPSharedOutput, archive: MoveEffectArchive,
                                        activeSpawns: readonly MoveEffectParticleSpawn[],
                                        activeResourceKeys: ReadonlySet<string>): CompiledMoveEffectModel[] {
    const compiled: CompiledMoveEffectModel[] = [];
    const referencedAnimations = new Map<number, Set<number>>();
    for (const spawn of activeSpawns) for (const pair of spawn.ModelResources ?? []) {
        let animations = referencedAnimations.get(pair.ModelResourceID);
        if (animations === undefined) referencedAnimations.set(pair.ModelResourceID, animations = new Set());
        animations.add(pair.AnimationResourceID);
    }
    for (const resource of archive.MoveEffects.Resources) {
        if (resource.Type !== 3 || resource.GeoNodes === undefined) continue;
        if (!activeResourceKeys.has(`${resource.ArchiveID}:${resource.ResourceID}`)) continue;
        const bank = archive.MoveEffectResourceBanks[resource.ArchiveID];
        if (bank === undefined) continue;
        const nodes = resource.GeoNodes;
        const pose = new PokemonModelPose(bank.Data.createDataView(), nodes, mat4.create());
        pose.update(null);
        const animationResourceIDs = [...(referencedAnimations.get(resource.ResourceID) ?? [])];
        if (animationResourceIDs.length === 0) {
            const adjacentAnimation = archive.MoveEffects.Resources.some((candidate) => candidate.ArchiveID === resource.ArchiveID &&
                candidate.Type === 4 && candidate.ResourceID === resource.ResourceID + 1);
            animationResourceIDs.push(adjacentAnimation ? resource.ResourceID + 1 : -1);
        }
        const state = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, bank.Data, bank.ArchiveID));
        state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
            F3DEX2.RSP_Geometry.G_CULL_BACK | F3DEX2.RSP_Geometry.G_LIGHTING | F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
        state.gSPTexture(false, 0, 0, 0xFFFF, 0xFFFF);
        state.gDPSetOtherModeH(20, 2, 1 << 20);
        for (const node of nodes) for (const texture of [...node.Textures, ...node.Palettes]) {
            if (texture.DataOffset >= 0) {
                state.registerTextureDescriptor(0x0F000000 + texture.DataOffset, texture.Format, texture.Size, texture.Width, texture.Height);
                state.registerTextureDescriptor(0x0E000000 + texture.DataOffset, texture.Format, texture.Size, texture.Width, texture.Height);
                state.registerTextureDescriptor(0x02000000 + texture.DataOffset, texture.Format, texture.Size, texture.Width, texture.Height);
                state.registerTextureDescriptor(0x8FF00000 + texture.DataOffset, texture.Format, texture.Size, texture.Width, texture.Height);
            }
        }
        const initialTexture = nodes.flatMap((node) => node.Textures)[0];
        if (initialTexture !== undefined) {
            const address = 0x0F000000 + initialTexture.DataOffset;
            const bitsPerPixel = [4, 8, 16, 32][initialTexture.Size];
            const line = Math.ceil(initialTexture.Width * bitsPerPixel / 64);
            state.gDPSetTextureImage(initialTexture.Format, initialTexture.Size, initialTexture.Width, address);
            state.gDPSetTile(initialTexture.Format, initialTexture.Size, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
            state.gDPLoadBlock(7, 0, 0, initialTexture.Width * initialTexture.Height - 1, 0);
            state.gDPSetTile(initialTexture.Format, initialTexture.Size, line, 0, 0, 0, 0, 0, 0, 0, 0, 0);
            state.gDPSetTileSize(0, 0, 0, (initialTexture.Width - 1) << 2, (initialTexture.Height - 1) << 2);
        }
        const lightColors: number[][] = [];
        const lightDirections: number[][] = [];
        const ambientColor = [0, 0, 0];
        const activeMatrixSlots: (number | null)[] = [];
        const textureAddress = (offset: number): number => 0x0F000000 + offset;
        const loadI4Texture = (address: number, width: number, tile: number = 0, tmem: number = 0,
                               shifts: number = 0, shiftt: number = 0): void => {
            state.registerTextureDescriptor(address, 4, 0, width, width);
            state.gDPSetTextureImage(4, 1, Math.max(1, width >>> 1), address);
            state.gDPSetTile(4, 1, Math.ceil(width / 16), tmem, 7, 0, 0, Math.log2(width), shiftt, 0, Math.log2(width), shifts);
            state.gDPLoadTile(7, 0, 0, (width - 1) << 1, (width - 1) << 2);
            state.gDPSetTile(4, 0, Math.ceil(width / 16), tmem, tile, 0, 0, Math.log2(width), shiftt, 0, Math.log2(width), shifts);
            state.gDPSetTileSize(tile, 0, 0, (width - 1) << 2, (width - 1) << 2);
            state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
        };
        const loadDualI4Texture = (argument: number, width: number, shifts: number = 0, shiftt: number = 0): boolean => {
            if (argument < 0 || argument + 8 > bank.Data.byteLength) return false;
            const first = bank.Data.createDataView().getUint32(argument) & 0x000FFFFF;
            const second = bank.Data.createDataView().getUint32(argument + 4) & 0x000FFFFF;
            if (first >= bank.Data.byteLength || second >= bank.Data.byteLength) return false;
            loadI4Texture(textureAddress(first), width, 0, 0, shifts, shiftt);
            loadI4Texture(textureAddress(second), width, 1, 0x100, shifts, shiftt);
            return true;
        };
        const hasVertexArrayDeclaration = nodes.some((node) =>
            node.Command === 0x17 && node.VertexArrayOffset >= 0 && node.VertexCount > 0);
        const applyDrawCallback = (node: PokemonGeoNode, textures: PokemonTextureDescriptor[]): boolean => {
            const argument = node.DrawCallbackArgument;
            state.setModelParticleColorMode('all');
            state.setLeerEyeMask(false);
            if (node.DrawCallbackSemantic === 'BuildAlphaScaledVertexDisplayListCallback') {
                if (!hasVertexArrayDeclaration) return false;
                state.setPokemonStadiumGsParticleVertexAlphaScale(true);
                return true;
            }
            if (node.DrawCallbackSemantic === 'DrawBattleResourceCurrentPokemonTextureCallback') {
                // The callback's argument is a frame selector, not a serialized
                // texture pointer. Install the exact RGBA16 32x32 RDP layout
                // against a harmless fragment-backed placeholder; the draw
                // instance replaces TEXEL0 with the live capture target.
                const address = textureAddress(0);
                state.registerTextureDescriptor(address, 0, 2, 32, 32);
                state.gDPSetTextureImage(0, 2, 32, address);
                state.gDPSetTile(0, 2, 0, 0, 7, 0, 2, 5, 0, 0, 5, 0);
                state.gDPLoadBlock(7, 0, 0, 1023, 0x100);
                state.gDPSetTile(0, 2, 8, 0, 0, 0, 2, 5, 0, 0, 5, 0);
                state.gDPSetTileSize(0, 0, 0, 31 << 2, 31 << 2);
                state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
                state.setPokemonStadiumGsCurrentPokemonTexture(true);
                return true;
            }
            switch (node.DrawCallback) {
            // Fragment 31's callback stubs jump into fragment 62. These cases
            // reproduce the texture setup performed by those target routines;
            // per-particle color and scroll values begin at their authored
            // frame-zero defaults and are updated by the particle renderer.
            case pokemonDrawCallback.I4Texture32A: case pokemonDrawCallback.I4Texture32B:
            case pokemonDrawCallback.I4Texture32C: case pokemonDrawCallback.I4Texture32D:
            case pokemonDrawCallback.I4Texture32E:
                if (argument < 0) return false;
                loadI4Texture(textureAddress(argument), 32);
                return true;
            case pokemonDrawCallback.DualI4Texture64A: case pokemonDrawCallback.DualI4Texture64B:
                return loadDualI4Texture(argument, 64);
            case pokemonDrawCallback.CyanDualI4TextureA: case pokemonDrawCallback.CyanDualI4TextureB:
            case pokemonDrawCallback.CyanDualI4Primitive: case pokemonDrawCallback.DualI4Texture32A:
            case pokemonDrawCallback.DualI4Texture32B: case pokemonDrawCallback.DualI4Texture32C:
            case pokemonDrawCallback.LeerEyeTexture: case pokemonDrawCallback.DualI4Texture32D:
            case pokemonDrawCallback.DualI4Texture32WithLOD: {
                const loaded = loadDualI4Texture(argument, 32,
                    node.DrawCallback === pokemonDrawCallback.LeerEyeTexture ? 1 : 0,
                    node.DrawCallback === pokemonDrawCallback.LeerEyeTexture ? 1 : 0);
                if (!loaded) return false;
                if (node.DrawCallback === pokemonDrawCallback.LeerEyeTexture) {
                    state.setModelParticleColorMode('none');
                    state.setLeerEyeMask(true);
                    state.setTextureScrollSpeeds([[0, 0], [0, -3]]);
                }
                if (node.DrawCallback === pokemonDrawCallback.CyanDualI4TextureA) state.gSPSetEnvColor(155, 255, 255, 255);
                else if (node.DrawCallback === pokemonDrawCallback.CyanDualI4TextureB) state.gSPSetEnvColor(155, 255, 255, 255);
                else if (node.DrawCallback === pokemonDrawCallback.CyanDualI4Primitive) {
                    state.gSPSetPrimColor(0x80, 255, 255, 255, 255);
                    state.gSPSetEnvColor(0, 255, 255, 255);
                } else if (node.DrawCallback === pokemonDrawCallback.DualI4Texture32WithLOD)
                    state.gSPSetPrimColor(0x78, 255, 255, 255, 255);
                return true;
            }
            case pokemonDrawCallback.RGBA16Texture32:
                if (argument < 0) return false;
                state.registerTextureDescriptor(textureAddress(argument), 0, 2, 32, 32);
                state.gDPSetTextureImage(0, 2, 32, textureAddress(argument));
                state.gDPSetTile(0, 2, 8, 0, 7, 0, 0, 5, 0, 0, 5, 0);
                state.gDPLoadBlock(7, 0, 0, 1023, 0);
                state.gDPSetTile(0, 2, 8, 0, 0, 0, 0, 5, 0, 0, 5, 0);
                state.gDPSetTileSize(0, 0, 0, 31 << 2, 31 << 2);
                state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
                return true;
            case pokemonDrawCallback.IndexedTexture: {
                const textureIndex = node.DrawCallbackRawArgument & 0xFF;
                const texture = textures[textureIndex];
                if (texture === undefined || texture.DataOffset < 0) return false;
                const address = textureAddress(texture.DataOffset);
                state.registerTextureDescriptor(address, texture.Format, texture.Size, texture.Width, texture.Height);
                state.gDPSetTextureImage(texture.Format, texture.Size, texture.Width, address);
                state.gDPSetTile(texture.Format, texture.Size, Math.ceil(texture.Width * 16 / 64), 0, 7, 0,
                    0, 0, 0, 0, 0, 0);
                state.gDPLoadTile(7, 0, 0, (texture.Width - 1) << 2, (texture.Height - 1) << 2);
                state.gDPSetTile(texture.Format, texture.Size, Math.ceil(texture.Width * 16 / 64), 0, 0, 0,
                    0, 0, 0, 0, 0, 0);
                state.gDPSetTileSize(0, 0, 0, (texture.Width - 1) << 2, (texture.Height - 1) << 2);
                state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
                return true;
            }
            case pokemonDrawCallback.RepeatedDualI4Texture:
                if (argument < 0) return false;
                loadI4Texture(textureAddress(argument), 32);
                loadI4Texture(textureAddress(argument), 32, 1, 0x100);
                return true;
            case pokemonDrawCallback.WhitePrimitive:
                state.gSPSetPrimColor(0x80, 255, 255, 255, 255);
                return true;
            case pokemonDrawCallback.WhitePrimitiveBlackEnvironmentA:
            case pokemonDrawCallback.WhitePrimitiveBlackEnvironmentB:
            case pokemonDrawCallback.WhitePrimitiveBlackEnvironmentC:
            case pokemonDrawCallback.WhitePrimitiveBlackEnvironmentD:
            case pokemonDrawCallback.WhitePrimitiveBlackEnvironmentE:
                state.gSPSetPrimColor(0, 255, 255, 255, 255);
                state.gSPSetEnvColor(0, 0, 0, 0);
                return true;
            case pokemonDrawCallback.PinkEnvironment:
                state.gSPSetPrimColor(0x80, 255, 255, 255, 255);
                state.gSPSetEnvColor(255, 55, 100, 255);
                return true;
            case pokemonDrawCallback.YellowEnvironment:
                state.gSPSetPrimColor(0x80, 255, 255, 255, 255);
                state.gSPSetEnvColor(255, 255, 100, 255);
                return true;
            case pokemonDrawCallback.RedPrimitiveAlpha:
                state.gSPSetPrimColor(0, 255, 0, 0, 255);
                state.setModelParticleColorMode('alpha');
                return true;
            default:
                return false;
            }
        };
        const walk = (index: number, textures: PokemonTextureDescriptor[], palettes: PokemonTextureDescriptor[], billboard: number): void => {
            const node = nodes[index];
            const activeBillboard = node.Command === 0x1D && (node.TransformMode & 2) !== 0 ? 8 : billboard;
            const activeTextures = node.Textures.length === 0 ? textures : node.Textures;
            const activePalettes = node.Palettes.length === 0 ? palettes : node.Palettes;
            const previousSlotMatrix = node.MatrixSlot >= 0 ? activeMatrixSlots[node.MatrixSlot] : null;
            if (node.Command === 0x1D && node.MatrixSlot >= 0) activeMatrixSlots[node.MatrixSlot] = index;
            if (node.Command === 0x14 && lightColors.length < 7) {
                const latitude = node.LightAngles[0] * Math.PI / 180;
                const longitude = node.LightAngles[1] * Math.PI / 180;
                lightColors.push(node.LightColor.slice(0, 3).map((component) => component / 255));
                lightDirections.push([
                    Math.cos(latitude) * Math.sin(longitude),
                    Math.sin(latitude),
                    Math.cos(latitude) * Math.cos(longitude),
                ]);
                for (let component = 0; component < 3; component++)
                    ambientColor[component] = Math.min(1, ambientColor[component] + node.LightColor[component] * node.LightColor[3] / 100 / 255);
                state.setLights(lightColors, lightDirections, ambientColor);
            } else if (node.Command === 0x16) {
                if (node.LightColor[0] !== 0xFF || node.LightColor[1] !== 0xFF || node.LightColor[2] !== 0xFF)
                    for (let component = 0; component < 3; component++) ambientColor[component] = node.LightColor[component] / 255;
                state.setLights(lightColors, lightDirections, ambientColor);
            } else if (node.Command === 0x23) {
                state.setModelParticleColorMode('all');
                state.setLeerEyeMask(false);
                setMaterialCombine(state, node.MaterialFlags);
                const color = node.MaterialFlags === 1 ? 0xFFFFFFFF : node.Color;
                state.gSPSetPrimColor(0xFF, color >>> 24, color >>> 16 & 0xFF, color >>> 8 & 0xFF, color & 0xFF);
                if (node.PaletteIndex >= 0 && node.PaletteIndex < activePalettes.length) {
                    const palette = activePalettes[node.PaletteIndex];
                    if (palette.DataOffset >= 0) F3DEX2.runDL_F3DEX2(state, 0x0F000000 + palette.DataOffset);
                }
                if (node.TextureIndex >= 0 && node.TextureIndex < activeTextures.length) {
                    const texture = activeTextures[node.TextureIndex];
                    state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
                    state.gDPSetTextureImage(texture.Format, texture.Size, texture.Width, 0x0F000000 + texture.DataOffset);
                }
                if (node.DisplayList >= 0) F3DEX2.runDL_F3DEX2(state, 0x0F000000 + node.DisplayList);
                state.commitMaterialState();
            } else if (node.Command === 0x22 && node.DisplayList < 0 && node.DrawCallbackArgument >= 0 &&
                (node.DrawCallback === pokemonDrawCallback.GeneratedTextureCoordinates ||
                    node.DrawCallback === pokemonDrawCallback.LinearGeneratedTextureCoordinates)) {
                const queue = node.Layer & 0x0F;
                const finish = state.beginRenderQueue(queue, activeBillboard);
                const address = 0x0F000000 + node.DrawCallbackArgument;
                state.registerTextureDescriptor(address, 4, 0, 32, 32);
                // The reflection callbacks use gDPLoadTextureTile_4b on the
                // authored intensity mask, then select spherical or linear
                // LookAt reflection coordinates for the following mesh.
                state.gDPSetTextureImage(4, 1, 16, address);
                state.gDPSetTile(4, 1, 2, 0, 7, 0, 0, 5, 0, 0, 5, 0);
                state.gDPLoadTile(7, 0, 0, 31 << 1, 31 << 2);
                state.gDPSetTile(4, 0, 2, 0, 0, 0, 0, 5, 0, 0, 5, 0);
                state.gDPSetTileSize(0, 0, 0, 31 << 2, 31 << 2);
                state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
                state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_TEXTURE_GEN |
                    (node.DrawCallback === pokemonDrawCallback.LinearGeneratedTextureCoordinates ?
                        F3DEX2.RSP_Geometry.G_TEXTURE_GEN_LINEAR : 0));
                state.setModelParticleColorMode('none');
                finish();
            } else if (node.Command === 0x22 && node.DisplayList < 0 && node.DrawCallback !== 0) {
                const queue = node.Layer & 0x0F;
                const finish = state.beginRenderQueue(queue, activeBillboard);
                if (!applyDrawCallback(node, activeTextures))
                    console.warn(`Pokémon Stadium move-effect draw callback 0x${node.DrawCallback.toString(16)} ` +
                        `is not implemented (resource ${resource.ArchiveID}:${resource.ResourceID})`);
                finish();
            } else if ((node.Command === 0x1E || node.Command === 0x20 || node.Command === 0x21 || node.Command === 0x22) && node.DisplayList >= 0) {
                const queue = node.Layer & 0x0F;
                const finish = state.beginRenderQueue(queue, activeBillboard);
                state.setMatrixIndex(node.Command === 0x1E && node.MatrixSlot >= 0
                    ? activeMatrixSlots[node.MatrixSlot] ?? index : index);
                state.gDPSetOtherModeL(0, 32, (zBufferedRenderModes[queue] ?? zBufferedRenderModes[0]) | 0x0C080000);
                F3DEX2.runDL_F3DEX2(state, 0x0F000000 + node.DisplayList);
                finish();
            }
            for (const child of pose.geoChildren[index]) walk(child, activeTextures, activePalettes, activeBillboard);
            if (node.Command === 0x1D && node.MatrixSlot >= 0) activeMatrixSlots[node.MatrixSlot] = previousSlotMatrix;
        };
        for (const root of pose.geoRoots) walk(root, [], [], 0);
        const output = state.finish();
        if (output !== null) for (const animationResourceID of animationResourceIDs) {
            const animationResource = animationResourceID < 0 ? undefined : archive.MoveEffects.Resources.find((candidate) =>
                candidate.ArchiveID === resource.ArchiveID && candidate.Type === 4 &&
                candidate.ResourceID === animationResourceID);
            const animation = animationResource?.Type === 4 ? animationResource.Animation : undefined;
            const frameMatrices: mat4[][] = [];
            const frameCount = animation?.FrameCount ?? 1;
            for (let frame = 0; frame < frameCount; frame++) {
                pose.update(animation === undefined ? null : { animation, index: 0, frame, elapsed: frame });
                frameMatrices.push(pose.nodeMatrices.map((matrix) => mat4.clone(matrix)));
            }
            compiled.push({ ArchiveID: resource.ArchiveID, ResourceID: resource.ResourceID, AnimationResourceID: animationResourceID,
                Output: output, FrameMatrices: frameMatrices });
        }
    }
    return compiled;
}
