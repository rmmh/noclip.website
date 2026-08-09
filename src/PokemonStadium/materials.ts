import { GfxShaderLibrary } from '../gfx/helpers/GfxShaderLibrary.js';
import { DeviceProgram } from '../Program.js';
import * as F3DEX2 from './F3DEX2.js';

export const materialCombineModes = [
    [31,31,31,3,7,7,7,3,0,31,4,31,0,7,6,7], [1,31,3,31,7,7,7,1,0,31,4,31,0,7,6,7],
    [1,3,8,3,7,7,3,7,0,31,4,31,0,7,6,7], [1,31,3,31,7,7,7,3,0,31,4,31,0,7,6,7],
    [1,31,3,31,1,7,3,7,0,31,4,31,0,7,6,7], [31,31,31,3,7,7,7,3,31,31,31,0,0,7,6,7],
    [1,31,3,31,7,7,7,1,31,31,31,0,0,7,6,7], [1,3,8,3,7,7,3,7,31,31,31,0,0,7,6,7],
    [1,31,3,31,7,7,7,3,31,31,31,0,0,7,6,7], [1,31,3,31,1,7,3,7,31,31,31,0,0,7,6,7],
    [31,31,31,4,7,7,7,4,31,31,31,0,0,7,6,7], [1,31,4,31,7,7,7,1,31,31,31,0,0,7,6,7],
    [1,4,8,4,7,7,3,7,31,31,31,0,0,7,6,7], [1,31,4,31,7,7,7,4,31,31,31,0,0,7,6,7],
    [1,31,4,31,1,7,4,7,31,31,31,0,0,7,6,7],
];

// sModelRenderModes[1]: the normal Z-buffered model queues. Stadium emits geometry
// into queues 0..8, then links those queues in numeric order.
export const zBufferedRenderModes = [
    0x03124370, 0x00112230, 0x00112E10, 0x00112230, 0x00113238,
    0x00104A50, 0x00104E50, 0x00104A50, 0x00104A70,
];

export function setMaterialCombine(state: F3DEX2.RSPState, index: number): void {
    const m = materialCombineModes[index] ?? materialCombineModes[0];
    const w0 = (m[0] << 20) | (m[2] << 15) | (m[4] << 12) | (m[6] << 9) | (m[8] << 5) | m[10];
    const w1 = ((m[1] << 28) | (m[3] << 15) | (m[5] << 12) | (m[7] << 9) |
        (m[9] << 24) | (m[12] << 21) | (m[14] << 18) | (m[11] << 6) | (m[13] << 3) | m[15]) >>> 0;
    state.gDPSetCombine(w0, w1);
}

export function setCombineTuple(state: F3DEX2.RSPState, m: readonly number[]): void {
    const w0 = (m[0] << 20) | (m[2] << 15) | (m[4] << 12) | (m[6] << 9) | (m[8] << 5) | m[10];
    const w1 = ((m[1] << 28) | (m[3] << 15) | (m[5] << 12) | (m[7] << 9) |
        (m[9] << 24) | (m[12] << 21) | (m[14] << 18) | (m[11] << 6) | (m[13] << 3) | m[15]) >>> 0;
    state.gDPSetCombine(w0, w1);
}

// set_particle_primitive_environment_combine, used by the majority of Stadium particle render callbacks:
// (primitive - environment) * texel + environment, with texel * primitive alpha.
export const particlePrimitiveEnvironmentCombine = [3, 5, 1, 5, 1, 7, 3, 7, 31, 31, 31, 0, 7, 7, 7, 0];
// func_81405D38: noisy IA particles blend between the authored environment and
// primitive colors in cycle two. Flamethrower's style 71 uses this callback.
export const noisyParticlePrimitiveEnvironmentCombine = [7, 15, 5, 7, 7, 7, 7, 1, 3, 5, 0, 5, 0, 7, 3, 7];

// set_dual_texture_particle_combine / set_dual_texture_color_particle_combine. Cycle zero interpolates TEXEL0 and TEXEL1
// with PRIM_LOD_FRAC; cycle one applies the particle primitive/environment
// colors. The latter callback keeps TEXEL0 alpha instead of interpolating it.
export const dualTextureColorAndAlphaCombine = [2, 1, 14, 1, 2, 1, 6, 1, 3, 5, 0, 5, 0, 7, 3, 7];
export const dualTextureColorOnlyCombine = [2, 1, 14, 1, 7, 7, 7, 1, 3, 5, 0, 5, 0, 7, 3, 7];
// draw_energy_ring_pool: interpolate the two intensity textures by PRIM_LOD_FRAC,
// then apply the ring's primitive/environment colors in cycle one.
export const customRingCombine = [2, 1, 14, 1, 2, 1, 3, 1, 3, 5, 0, 5, 0, 7, 5, 7];
// set_textured_primitive_environment_shade_combine, installed before archived resource display list 0x20.
export const texturedPrimitiveEnvironmentShadeCombine = [3, 5, 1, 5, 1, 7, 3, 7, 0, 31, 4, 31, 0, 7, 4, 7];

// draw_move_effect_screen_flash draws an untextured primitive-color rectangle over the full
// 320x240 battle viewport. The original RDP state uses ordinary source-alpha
// blending, so a full-screen triangle is an exact modern equivalent.
export class MoveEffectScreenFlashProgram extends DeviceProgram {
    public static ub_Color = 0;

    public override vert = `
${GfxShaderLibrary.fullscreenVS}
`;

    public override frag = `
layout(std140) uniform ub_Color {
    vec4 u_Color;
};

void main() {
    gl_FragColor = u_Color;
}
`;
}
