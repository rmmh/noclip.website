import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { RSPSharedOutput } from '../BanjoKazooie/f3dex.js';
import * as RDP from '../Common/N64/RDP.js';
import { MoveEffectArchive, MoveEffectResource } from './effects.js';
import * as F3DEX2 from './F3DEX2.js';
import { MoveEffectTextureDataMap } from './archive.js';
import {
    NeedleProjectileFrameGeometry, PointTrailKind, WaveGridKind, makeArchingNeedleVolleyGeometries,
    makeCustomRingGeometry, makeNeedleProjectileGeometries, makePlantParticlePoolGeometries,
    makePointTrailGeometries, makePrismaticPointTrailGeometries, makeReturningRibbonGeometries,
    makeSpiralRibbonGeometries, makeSpiralRibbonTexture, makeSwiftStarPoolGeometries,
    makeWaveGridGeometries, moveEffectPreviewFrames, needleHeadPositions, needleHeadTriangles,
} from './move_effect_geometry.js';
import { customRingCombine, particlePrimitiveEnvironmentCombine, setCombineTuple } from './materials.js';

export type SpiralRibbonPalette = 'cyan' | 'white' | 'yellow';
export type NeedleProjectileKind = 'needleProjectile' | 'archingNeedleVolley';
export type PlantParticleKind = 'razorLeafPool' | 'petalDancePool';

export interface CustomMoveEffectSelection {
    CustomRing?: { ArchiveID: number; Modes: number };
    SpiralRibbon?: SpiralRibbonPalette;
    WaveGrid?: { ArchiveID: number; Kind: WaveGridKind };
    PointTrail?: PointTrailKind;
    ReturningRibbonArchive?: number;
    NeedleProjectile?: NeedleProjectileKind;
    PlantParticle?: { ArchiveID: number; Kind: PlantParticleKind };
    SwiftArchive?: number;
}

export interface CustomMoveEffectOutputs {
    CustomRings: { ArchiveID: number; Frame: number; Mode: 0 | 1; Output: F3DEX2.RSPOutput }[];
    SpiralRibbons: { Frame: number; Palette: SpiralRibbonPalette; Output: F3DEX2.RSPOutput }[];
    WaveGrids: { ArchiveID: number; Frame: number; Kind: WaveGridKind; Output: F3DEX2.RSPOutput }[];
    PointTrails: { Frame: number; Kind: PointTrailKind; Output: F3DEX2.RSPOutput }[];
    ReturningRibbons: { ArchiveID: number; Frame: number; Output: F3DEX2.RSPOutput }[];
    NeedleProjectiles: { Frame: number; Kind: NeedleProjectileKind; Output: F3DEX2.RSPOutput }[];
    PlantParticles: { ArchiveID: number; Frame: number; Kind: PlantParticleKind; Output: F3DEX2.RSPOutput }[];
    SwiftStars: { ArchiveID: number; Frame: number; Output: F3DEX2.RSPOutput }[];
}

export function compileCustomMoveEffects(sharedOutput: RSPSharedOutput, moveEffectArchive: MoveEffectArchive,
                                         battleScale: number, selection: CustomMoveEffectSelection): CustomMoveEffectOutputs {
    const metadata = moveEffectArchive.MoveEffects;
    const customRingOutputs: CustomMoveEffectOutputs['CustomRings'] = [];
    const spiralRibbonOutputs: CustomMoveEffectOutputs['SpiralRibbons'] = [];
    const waveGridOutputs: CustomMoveEffectOutputs['WaveGrids'] = [];
    const pointTrailOutputs: CustomMoveEffectOutputs['PointTrails'] = [];
    const returningRibbonOutputs: CustomMoveEffectOutputs['ReturningRibbons'] = [];
    const needleProjectileOutputs: CustomMoveEffectOutputs['NeedleProjectiles'] = [];
    const plantParticleOutputs: CustomMoveEffectOutputs['PlantParticles'] = [];
    const swiftOutputs: CustomMoveEffectOutputs['SwiftStars'] = [];

    // Moves wired to start_attacker_energy_ring_effect bypass fragment34's particle pool and
    // animate a 31-segment, dual-textured ring in gEnergyRingPool. Preserve its
    // exact CPU-updated geometry as one immutable frame mesh; only the
    // selected frame is submitted, avoiding a modern approximation of the
    // vertex waves or their translucent edge colors.
    for (const bank of moveEffectArchive.MoveEffectResourceBanks) {
        if (bank.ArchiveID !== selection.CustomRing?.ArchiveID) continue;
        const primary = metadata.Resources.find((resource) => resource.ArchiveID === bank.ArchiveID && resource.Type === 1 && resource.ResourceID === 0x43);
        const secondary = metadata.Resources.find((resource) => resource.ArchiveID === bank.ArchiveID && resource.Type === 1 && resource.ResourceID === 0x44);
        if (primary === undefined || secondary === undefined) continue;
        for (let mode = 0 as 0 | 1; mode <= 1; mode++) for (let frame = 0; frame < moveEffectPreviewFrames; frame++) {
            if ((selection.CustomRing.Modes & (1 << mode)) === 0) continue;
            const geometry = makeCustomRingGeometry(frame, mode, battleScale);
            const state = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, geometry.Data, bank.ArchiveID));
            state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE | F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
            state.gDPSetOtherModeH(20, 2, 1 << 20);
            state.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_PASS | RDP.RENDER_MODES.G_RM_AA_ZB_XLU_SURF2);
            setCombineTuple(state, customRingCombine);
            // Exact gDPLoadTextureTile_4b / gDPLoadMultiTile_4b sequence
            // used by draw_energy_ring_pool. Unlike gDPLoadTextureBlock_4b, the
            // tile macros present the packed I4 source to the load tile as
            // an 8-bit, half-width image.
            const loadI4Tile = (resource: MoveEffectResource, tile: number, tmem: number): void => {
                const address = 0x0E000000 + resource.DataOffset;
                state.registerTextureDescriptor(address, 4, 0, 32, 32);
                state.gDPSetTextureImage(4, 1, 16, address);
                state.gDPSetTile(4, 1, 2, tmem, 7, 0, 0, 5, 0, 0, 5, 0);
                state.gDPLoadTile(7, 0, 0, 31 << 1, 31 << 2);
                state.gDPSetTile(4, 0, 2, tmem, tile, 0, 0, 5, 0, 0, 5, 0);
                state.gDPSetTileSize(tile, 0, 0, 31 << 2, 31 << 2);
            };
            loadI4Tile(primary, 0, 0); loadI4Tile(secondary, 1, 0x100);
            state.gSPTexture(true, 0, 0, 0x8000, 0x8000);
            state.setTextureScrollSpeeds([[1, 0], [-1, 0]]);
            state.gSPSetPrimColor(0x80, 0xFF, 0xFF, 0xC8, 0x80);
            const environmentAlpha = mode === 0 ? Math.max(0, 0xFF - Math.max(0, frame + 1 - 30) * 10) :
                Math.min(0xFF, (frame + 1) * 8);
            state.gSPSetEnvColor(mode === 0 ? 0x20 : 0xFF, 0x20, mode === 0 ? 0xFF : 0x20, environmentAlpha);
            for (let segment = 0; segment < 30; segment++) {
                state.gSPVertex(0x0F000000 + segment * 2 * 0x10, 4, 0);
                state.gSPTri(0, 2, 1); state.gSPTri(2, 3, 1);
            }
            const output = state.finish();
            if (output !== null) customRingOutputs.push({ ArchiveID: bank.ArchiveID, Frame: frame, Mode: mode, Output: output });
        }
    }
    const spiralTexture = makeSpiralRibbonTexture();
    const spiralPalettes: readonly [SpiralRibbonPalette, readonly [number, number, number], readonly [number, number, number]][] = [
        ['cyan', [0x64, 0xC8, 0xFF], [0, 0x64, 0xC8]],
        ['white', [0xFF, 0xFF, 0xFF], [0x64, 0x96, 0x96]],
        ['yellow', [0xFF, 0xFF, 0x64], [0x96, 0x96, 0]],
    ];
    for (const [frame, geometry] of (selection.SpiralRibbon === undefined ? [] : makeSpiralRibbonGeometries(battleScale)).entries()) {
        for (const [palette, primitive, environment] of spiralPalettes) {
            if (palette !== selection.SpiralRibbon) continue;
            const state = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(spiralTexture, geometry.Data));
            state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                F3DEX2.RSP_Geometry.G_LIGHTING | F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
            state.gDPSetOtherModeH(20, 2, 0);
            state.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_AA_ZB_XLU_SURF2);
            setCombineTuple(state, particlePrimitiveEnvironmentCombine);
            state.registerTextureDescriptor(0x0E000000, 3, 1, 8, 16);
            state.gDPSetTextureImage(3, 1, 8, 0x0E000000);
            state.gDPSetTile(3, 1, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
            state.gDPLoadBlock(7, 0, 0, 8 * 16 - 1, 0);
            state.gDPSetTile(3, 1, 1, 0, 0, 0, 0, 4, 0, 0, 3, 0);
            state.gDPSetTileSize(0, 0, 0, 7 << 2, 15 << 2);
            state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
            state.gSPSetPrimColor(0, primitive[0], primitive[1], primitive[2], 0xC8);
            state.gSPSetEnvColor(environment[0], environment[1], environment[2], 0);
            for (let segment = 0; segment + 1 < geometry.VertexCount / 2; segment++) {
                state.gSPVertex(0x0F000000 + segment * 2 * 0x10, 4, 0);
                state.gSPTri(0, 2, 1); state.gSPTri(2, 3, 1);
            }
            const output = state.finish();
            if (output !== null) spiralRibbonOutputs.push({ Frame: frame, Palette: palette, Output: output });
        }
    }
    // draw_radial_wave_grid / draw_randomized_wave_grid /
    // draw_subtle_wave_grid emit a camera-facing 16x16 vertex-lit sheet.
    // Each family owns persistent heights and normals; resource A8 belongs
    // to the radial variant while 48 is shared by the other two.
    const waveGridKinds: readonly [WaveGridKind, number][] = [
        ['radialWaveGrid', 0xA8], ['randomWaveGrid', 0x48], ['subtleWaveGrid', 0x48],
    ];
    for (const [kind, resourceID] of waveGridKinds) for (const bank of moveEffectArchive.MoveEffectResourceBanks) {
        if (kind !== selection.WaveGrid?.Kind || bank.ArchiveID !== selection.WaveGrid.ArchiveID) continue;
        const resource = metadata.Resources.find((candidate) => candidate.ArchiveID === bank.ArchiveID &&
            candidate.Type === 1 && candidate.ResourceID === resourceID);
        if (resource === undefined) continue;
        for (const [frame, geometry] of makeWaveGridGeometries(kind).entries()) {
            const state = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, geometry.Data, bank.ArchiveID));
            state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                F3DEX2.RSP_Geometry.G_LIGHTING | F3DEX2.RSP_Geometry.G_TEXTURE_GEN | F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
            state.setLights([[1, 1, 1], [1, 1, 1]], [[30 / 127, 30 / 127, 10 / 127], [-30 / 127, 30 / 127, 10 / 127]], [1, 1, 1]);
            state.gDPSetOtherModeH(20, 2, 1 << 20);
            state.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_PASS | RDP.RENDER_MODES.G_RM_XLU_SURF2);
            setCombineTuple(state, [1, 15, 4, 7, 1, 7, 4, 7, 0, 15, 4, 7, 0, 7, 4, 7]);
            const address = 0x0E000000 + resource.DataOffset;
            state.registerTextureDescriptor(address, 0, 2, 32, 32);
            state.gDPSetTextureImage(0, 2, 32, address);
            state.gDPSetTile(0, 2, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
            state.gDPLoadBlock(7, 0, 0, 32 * 32 - 1, 0);
            state.gDPSetTile(0, 2, 8, 0, 0, 0, 0, 5, 0, 0, 5, 0);
            state.gDPSetTileSize(0, 0, 0, 31 << 2, 31 << 2);
            state.gSPTexture(true, 0, 0, 0x8000, 0x8000);
            state.gSPSetPrimColor(0, 0xFF, 0xFF, 0xFF, kind === 'subtleWaveGrid' ? 0x50 : 0x80);
            for (let x = 0; x < 15; x++) for (let z = 0; z < 15; z++) {
                const base = x * 16 + z;
                state.gSPVertex(0x0F000000 + base * 0x10, 2, 0);
                state.gSPVertex(0x0F000000 + (base + 16) * 0x10, 2, 2);
                if (((x * 15 + z) & 1) === 0) { state.gSPTri(1, 2, 0); state.gSPTri(1, 3, 2); }
                else { state.gSPTri(3, 2, 0); state.gSPTri(1, 3, 0); }
            }
            const output = state.finish();
            if (output !== null) waveGridOutputs.push({ ArchiveID: bank.ArchiveID, Frame: frame, Kind: kind, Output: output });
        }
    }
    const pointTrailKinds: readonly [PointTrailKind, readonly [number, number, number, number], readonly [number, number, number]][] = [
        ['cyanPointTrail', [0x64, 0xC8, 0xFF, 0xC8], [0, 0x64, 0xC8]],
        ['whitePointTrail', [0xFF, 0xFF, 0xFF, 0x64], [0x64, 0x96, 0x96]],
        ['yellowPointTrail', [0xFF, 0xFF, 0x64, 0xFF], [0x96, 0x96, 0]],
    ];
    for (const [kind, primitive, environment] of pointTrailKinds) {
        if (kind !== selection.PointTrail) continue;
        for (const [frame, geometry] of makePointTrailGeometries(kind, battleScale).entries()) {
            if (geometry.VertexCount === 0) continue;
            const state = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(spiralTexture, geometry.Data));
            state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                F3DEX2.RSP_Geometry.G_LIGHTING | F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
            state.gDPSetOtherModeH(20, 2, 0);
            state.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_ZB_XLU_SURF2);
            setCombineTuple(state, particlePrimitiveEnvironmentCombine);
            state.registerTextureDescriptor(0x0E000000, 3, 1, 8, 16);
            state.gDPSetTextureImage(3, 1, 8, 0x0E000000);
            state.gDPSetTile(3, 1, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
            state.gDPLoadBlock(7, 0, 0, 8 * 16 - 1, 0);
            state.gDPSetTile(3, 1, 1, 0, 0, 0, 0, 4, 0, 0, 3, 0);
            state.gDPSetTileSize(0, 0, 0, 7 << 2, 15 << 2);
            state.gSPTexture(true, 0, 0, 0xFFFF, 0xFFFF);
            state.gSPSetPrimColor(0, primitive[0], primitive[1], primitive[2], primitive[3]);
            state.gSPSetEnvColor(environment[0], environment[1], environment[2], 0);
            for (let trail = 0; trail < geometry.VertexCount / 40; trail++) for (let segment = 0; segment < 19; segment++) {
                const vertex = trail * 40 + segment * 2;
                state.gSPVertex(0x0F000000 + vertex * 0x10, 4, 0);
                state.gSPTri(0, 2, 1); state.gSPTri(2, 3, 1);
            }
            const output = state.finish();
            if (output !== null) pointTrailOutputs.push({ Frame: frame, Kind: kind, Output: output });
        }
    }
    for (const [frame, geometry] of (selection.PointTrail === 'prismaticPointTrail' ? makePrismaticPointTrailGeometries() : []).entries()) {
        const state = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(spiralTexture, geometry.Data));
        state.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
            F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
        state.gDPSetOtherModeH(20, 2, 0);
        state.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_ZB_XLU_SURF2);
        // G_CC_SHADE in both cycles; mode 8's interpolated vertex colors
        // are the complete material input and texture sampling is off.
        state.gDPSetCombine(0x00FFFFFF, 0xFFFE793C);
        state.gSPTexture(false, 0, 0, 0x8000, 0x8000);
        for (let segment = 0; segment < 19; segment++) {
            state.gSPVertex(0x0F000000 + segment * 9 * 0x10, 18, 0);
            for (let arm = 0; arm < 3; arm++) {
                const a = arm * 3, b = a + 9;
                state.gSPTri(a, b, a + 1); state.gSPTri(a + 1, b, b + 1);
                state.gSPTri(a + 1, b + 1, a + 2); state.gSPTri(a + 2, b + 1, b + 2);
                state.gSPTri(a + 2, b + 2, a); state.gSPTri(a, b + 2, b);
            }
        }
        state.gSPVertex(0x0F000000, 9, 0);
        for (let arm = 0; arm < 3; arm++) state.gSPTri(arm * 3 + 2, arm * 3 + 1, arm * 3);
        const output = state.finish();
        if (output !== null) pointTrailOutputs.push({ Frame: frame, Kind: 'prismaticPointTrail', Output: output });
    }
    const returningRibbonFrames = selection.ReturningRibbonArchive === undefined ? [] : makeReturningRibbonGeometries(battleScale);
    for (const bank of moveEffectArchive.MoveEffectResourceBanks) {
        if (bank.ArchiveID !== selection.ReturningRibbonArchive) continue;
        const resource = metadata.Resources.find((candidate) => candidate.ArchiveID === bank.ArchiveID &&
            candidate.Type === 1 && candidate.ResourceID === 0x49);
        if (resource === undefined) continue;
        for (const [frame, geometries] of returningRibbonFrames.entries()) {
            if (geometries.Tail.VertexCount === 0) continue;
            const tailState = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, geometries.Tail.Data, bank.ArchiveID));
            tailState.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
            tailState.gDPSetOtherModeH(20, 2, 0);
            tailState.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_ZB_XLU_SURF2);
            tailState.gDPSetCombine(0x00FFFFFF, 0xFFFE793C);
            tailState.gSPTexture(false, 0, 0, 0x8000, 0x8000);
            for (let ribbon = 0; ribbon < geometries.Tail.VertexCount / 30; ribbon++) for (let segment = 0; segment < 14; segment++) {
                const vertex = ribbon * 30 + segment * 2;
                tailState.gSPVertex(0x0F000000 + vertex * 0x10, 4, 0);
                tailState.gSPTri(0, 2, 1); tailState.gSPTri(2, 3, 1);
            }
            const tailOutput = tailState.finish();
            if (tailOutput !== null) returningRibbonOutputs.push({ ArchiveID: bank.ArchiveID, Frame: frame, Output: tailOutput });

            const headState = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, geometries.Heads.Data, bank.ArchiveID));
            headState.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
            headState.gDPSetOtherModeH(20, 2, 0);
            headState.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_ZB_XLU_SURF2);
            setCombineTuple(headState, [5, 4, 1, 4, 1, 7, 4, 7, 5, 4, 1, 4, 1, 7, 4, 7]);
            const address = 0x0E000000 + resource.DataOffset;
            headState.registerTextureDescriptor(address, 4, 0, 32, 32);
            headState.gDPSetTextureImage(4, 2, 1, address);
            headState.gDPSetTile(4, 2, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
            headState.gDPLoadBlock(7, 0, 0, 255, 1024);
            headState.gDPSetTile(4, 0, 2, 0, 0, 0, 0, 5, 0, 0, 5, 0);
            headState.gDPSetTileSize(0, 0, 0, 31 << 2, 31 << 2);
            headState.gSPTexture(true, 0, 0, 0x8000, 0x8000);
            headState.gSPSetPrimColor(0, 0xFF, 0xFF, 0xFF, 0xFF);
            headState.gSPSetEnvColor(0xFF, 0xFF, 0xFF, 0xFF);
            for (let ribbon = 0; ribbon < geometries.Heads.VertexCount / 4; ribbon++) {
                headState.gSPVertex(0x0F000000 + ribbon * 4 * 0x10, 4, 0);
                headState.gSPTri(0, 2, 1); headState.gSPTri(2, 3, 1);
            }
            const headOutput = headState.finish();
            if (headOutput !== null) returningRibbonOutputs.push({ ArchiveID: bank.ArchiveID, Frame: frame, Output: headOutput });
        }
    }
    const emptyEffectData = new ArrayBufferSlice(new ArrayBuffer(0));
    const buildNeedleProjectileFrames = (kind: NeedleProjectileKind, frames: NeedleProjectileFrameGeometry[]): void => {
    for (const [frame, geometries] of frames.entries()) {
        if (geometries.Trail.VertexCount === 0) continue;
        const trailState = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(emptyEffectData, geometries.Trail.Data));
        trailState.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
            F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
        trailState.gDPSetOtherModeH(20, 2, 0);
        trailState.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_ZB_XLU_SURF2);
        trailState.gDPSetCombine(0x00FFFFFF, 0xFFFE793C);
        trailState.gSPTexture(false, 0, 0, 0x8000, 0x8000);
        for (let projectile = 0; projectile < geometries.Trail.VertexCount / 30; projectile++)
            for (let segment = 0; segment < 14; segment++) {
                trailState.gSPVertex(0x0F000000 + (projectile * 30 + segment * 2) * 0x10, 4, 0);
                trailState.gSPTri(0, 2, 1); trailState.gSPTri(2, 3, 1);
            }
        const trailOutput = trailState.finish();
        if (trailOutput !== null) needleProjectileOutputs.push({ Frame: frame, Kind: kind, Output: trailOutput });

        const headState = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(emptyEffectData, geometries.Head.Data));
        headState.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
            F3DEX2.RSP_Geometry.G_CULL_BACK | F3DEX2.RSP_Geometry.G_LIGHTING | F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
        headState.gDPSetOtherModeH(20, 2, 0);
        headState.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_ZB_OPA_SURF2);
        setCombineTuple(headState, [5, 4, 1, 4, 1, 7, 4, 7, 5, 4, 1, 4, 1, 7, 4, 7]);
        const textureAddress = 0x0F000000 + geometries.Head.VertexCount * 0x10;
        headState.registerTextureDescriptor(textureAddress, 4, 0, 4, 4);
        headState.gDPSetTextureImage(4, 2, 1, textureAddress);
        headState.gDPSetTile(4, 2, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
        headState.gDPLoadBlock(7, 0, 0, 3, 2048);
        headState.gDPSetTile(4, 0, 1, 0, 0, 0, 0, 2, 0, 0, 2, 0);
        headState.gDPSetTileSize(0, 0, 0, 3 << 2, 3 << 2);
        headState.gSPTexture(true, 0, 0, 0x8000, 0x8000);
        headState.gSPSetPrimColor(0xFF, 197, 184, 122, 0xFF);
        headState.gSPSetEnvColor(197, 184, 122, 0xFF);
        for (let projectile = 0; projectile < geometries.Head.VertexCount / needleHeadPositions.length; projectile++) {
            headState.gSPVertex(0x0F000000 + projectile * needleHeadPositions.length * 0x10, needleHeadPositions.length, 0);
            for (const [a, b, c] of needleHeadTriangles) headState.gSPTri(a, b, c);
        }
        const headOutput = headState.finish();
        if (headOutput !== null) needleProjectileOutputs.push({ Frame: frame, Kind: kind, Output: headOutput });
    }
    };
    if (selection.NeedleProjectile === 'needleProjectile')
        buildNeedleProjectileFrames('needleProjectile', makeNeedleProjectileGeometries());
    else if (selection.NeedleProjectile === 'archingNeedleVolley')
        buildNeedleProjectileFrames('archingNeedleVolley', makeArchingNeedleVolleyGeometries());
    const plantFrames = selection.PlantParticle === undefined ? [] : makePlantParticlePoolGeometries(battleScale);
    for (const [kind, resourceID] of [['razorLeafPool', 0x1C], ['petalDancePool', 0x1E]] as const) {
        if (kind !== selection.PlantParticle?.Kind) continue;
        for (const bank of moveEffectArchive.MoveEffectResourceBanks) {
            if (bank.ArchiveID !== selection.PlantParticle.ArchiveID) continue;
            const resource = metadata.Resources.find((candidate) => candidate.ArchiveID === bank.ArchiveID &&
                candidate.Type === 1 && candidate.ResourceID === resourceID);
            if (resource === undefined) continue;
            for (const [frame, geometries] of plantFrames.entries()) {
                if (geometries.Trails.VertexCount === 0) continue;
                const trailState = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, geometries.Trails.Data, bank.ArchiveID));
                trailState.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                    F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
                trailState.gDPSetOtherModeH(20, 2, 0);
                trailState.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_ZB_XLU_SURF2);
                trailState.gDPSetCombine(0x00FFFFFF, 0xFFFE793C);
                trailState.gSPTexture(false, 0, 0, 0x8000, 0x8000);
                for (let particle = 0; particle < geometries.Trails.VertexCount / 20; particle++)
                    for (let segment = 0; segment < 9; segment++) {
                        trailState.gSPVertex(0x0F000000 + (particle * 20 + segment * 2) * 0x10, 4, 0);
                        trailState.gSPTri(0, 2, 1); trailState.gSPTri(2, 3, 1);
                    }
                const trailOutput = trailState.finish();
                if (trailOutput !== null) plantParticleOutputs.push({ ArchiveID: bank.ArchiveID, Frame: frame, Kind: kind, Output: trailOutput });

                const headState = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, geometries.Heads.Data, bank.ArchiveID));
                headState.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                    F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
                headState.gDPSetOtherModeH(20, 2, 0);
                headState.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_AA_ZB_TEX_EDGE | RDP.RENDER_MODES.G_RM_AA_ZB_TEX_EDGE2);
                setCombineTuple(headState, [31,31,31,1,7,7,7,1,31,31,31,1,7,7,7,1]);
                const address = 0x0E000000 + resource.DataOffset;
                headState.registerTextureDescriptor(address, 0, 2, 32, 32);
                headState.gDPSetTextureImage(0, 2, 32, address);
                headState.gDPSetTile(0, 2, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
                headState.gDPLoadBlock(7, 0, 0, 1023, 0);
                headState.gDPSetTile(0, 2, 8, 0, 0, 0, 0, 5, 0, 0, 5, 0);
                headState.gDPSetTileSize(0, 0, 0, 31 << 2, 31 << 2);
                headState.gSPTexture(true, 0, 0, 0x8000, 0x8000);
                for (let particle = 0; particle < geometries.Heads.VertexCount / 4; particle++) {
                    headState.gSPVertex(0x0F000000 + particle * 4 * 0x10, 4, 0);
                    headState.gSPTri(0, 1, 2); headState.gSPTri(1, 3, 2);
                }
                const headOutput = headState.finish();
                if (headOutput !== null) plantParticleOutputs.push({ ArchiveID: bank.ArchiveID, Frame: frame, Kind: kind, Output: headOutput });
            }
        }
    }
    const swiftFrames = selection.SwiftArchive === undefined ? [] : makeSwiftStarPoolGeometries(battleScale);
    for (const bank of moveEffectArchive.MoveEffectResourceBanks) {
        if (bank.ArchiveID !== selection.SwiftArchive) continue;
        const resource = metadata.Resources.find((candidate) => candidate.ArchiveID === bank.ArchiveID &&
            candidate.Type === 1 && candidate.ResourceID === 0x10);
        if (resource === undefined) continue;
        for (const [frame, geometries] of swiftFrames.entries()) {
            if (geometries.Trails.VertexCount > 0) {
                const trailState = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, geometries.Trails.Data, bank.ArchiveID));
                trailState.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                    F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
                trailState.gDPSetOtherModeH(20, 2, 0);
                trailState.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_ZB_XLU_SURF2);
                trailState.gDPSetCombine(0x00FFFFFF, 0xFFFE793C);
                trailState.gSPTexture(false, 0, 0, 0x8000, 0x8000);
                for (let star = 0; star < geometries.Trails.VertexCount / 20; star++)
                    for (let segment = 0; segment < 9; segment++) {
                        trailState.gSPVertex(0x0F000000 + (star * 20 + segment * 2) * 0x10, 4, 0);
                        trailState.gSPTri(0, 1, 2); trailState.gSPTri(1, 3, 2);
                    }
                const output = trailState.finish();
                if (output !== null) swiftOutputs.push({ ArchiveID: bank.ArchiveID, Frame: frame, Output: output });
            }
            const headState = new F3DEX2.RSPState(sharedOutput, new MoveEffectTextureDataMap(bank.Data, geometries.Heads.Data, bank.ArchiveID));
            headState.gSPSetGeometryMode(F3DEX2.RSP_Geometry.G_ZBUFFER | F3DEX2.RSP_Geometry.G_SHADE |
                F3DEX2.RSP_Geometry.G_SHADING_SMOOTH);
            headState.gDPSetOtherModeH(20, 2, 0);
            headState.gDPSetOtherModeL(0, 32, RDP.RENDER_MODES.G_RM_ZB_XLU_SURF | RDP.RENDER_MODES.G_RM_ZB_XLU_SURF2);
            setCombineTuple(headState, [5,4,1,4,1,7,4,7,5,4,1,4,1,7,4,7]);
            const address = 0x0E000000 + resource.DataOffset;
            headState.registerTextureDescriptor(address, 4, 0, 32, 32);
            headState.gDPSetTextureImage(4, 2, 1, address);
            headState.gDPSetTile(4, 2, 0, 0, 7, 0, 0, 0, 0, 0, 0, 0);
            headState.gDPLoadBlock(7, 0, 0, 255, 1024);
            headState.gDPSetTile(4, 0, 2, 0, 0, 0, 0, 5, 0, 0, 5, 0);
            headState.gDPSetTileSize(0, 0, 0, 31 << 2, 31 << 2);
            headState.gSPTexture(true, 0, 0, 0x8000, 0x8000);
            headState.gSPSetEnvColor(0xFF, 0xFF, 0x40, 0xFF);
            for (let star = 0; star < geometries.Heads.VertexCount / 4; star++) {
                headState.gSPVertex(0x0F000000 + star * 4 * 0x10, 4, 0);
                headState.gSPTri(0, 2, 1); headState.gSPTri(2, 3, 1);
            }
            const output = headState.finish();
            if (output !== null) swiftOutputs.push({ ArchiveID: bank.ArchiveID, Frame: frame, Output: output });
        }
    }

    return {
        CustomRings: customRingOutputs,
        SpiralRibbons: spiralRibbonOutputs,
        WaveGrids: waveGridOutputs,
        PointTrails: pointTrailOutputs,
        ReturningRibbons: returningRibbonOutputs,
        NeedleProjectiles: needleProjectileOutputs,
        PlantParticles: plantParticleOutputs,
        SwiftStars: swiftOutputs,
    };
}
