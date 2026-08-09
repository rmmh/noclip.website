import { F3DEX_GBI, RSPStateInterface } from '../BanjoKazooie/f3dex.js';
import { hexzero } from '../util.js';

interface F3DState extends RSPStateInterface {
    gDPSetFogColor?(rgba8: number): void;
    gSPFogPosition?(near: number, far: number): void;
    gDPSetPrimColor?(rgba8: number): void;
    gDPSetEnvColor?(rgba8: number): void;
}

function sign16(v: number): number {
    return (v << 16) >> 16;
}

function fogPositionToViewDistance(position: number): number {
    // The standard SM64 area frustum is 100..20000. gSPFogPosition values are
    // projected-depth positions in the 0..1000 range, not world-space distances.
    const clipNear = 100, clipFar = 20000;
    const normalizedPosition = position / 1000;
    return clipNear * clipFar / (clipFar - normalizedPosition * (clipFar - clipNear));
}

function moveWord(state: F3DState, w0: number, w1: number): void {
    const offset = (w0 >>> 8) & 0xFFFF;
    switch (w0 & 0xFF) {
    case 0x00: // G_MW_MATRIX
    case 0x02: // G_MW_NUMLIGHT
    case 0x04: // G_MW_CLIP
    case 0x06: // G_MW_SEGMENT; segment buffers already represent this table.
    case 0x0A: // G_MW_LIGHTCOL; light structures are consumed through G_MOVEMEM.
    case 0x0E: // G_MW_PERSPNORM
        break;
    case 0x08: { // G_MW_FOG
        const multiplier = sign16(w1 >>> 16);
        const fogOffset = sign16(w1 & 0xFFFF);
        if (multiplier !== 0) {
            const range = 128000 / multiplier;
            const near = 500 - fogOffset * range / 256;
            state.gSPFogPosition?.(fogPositionToViewDistance(near), fogPositionToViewDistance(near + range));
        }
    } break;
    case 0x0C: { // G_MW_POINTS
        const vertex = Math.floor(offset / 40);
        const where = offset - vertex * 40;
        state.gSPModifyVertex(vertex, where, w1);
    } break;
    default:
        console.error(`Unknown F3D G_MOVEWORD index ${(w0 & 0xFF).toString(16)}`);
    }
}

// Super Mario 64 uses the original Fast3D microcode. Its vertex count/start fields and
// triangle indices are incompatible with F3DEX, despite sharing most command opcodes.
export function runDL_F3D(state: F3DState, addr: number): void {
    const segmentBuffer = state.segmentBuffers[addr >>> 24];
    const view = segmentBuffer.createDataView();
    for (let i = addr & 0x00FFFFFF; i < segmentBuffer.byteLength; i += 8) {
        const w0 = view.getUint32(i), w1 = view.getUint32(i + 4);
        const cmd = w0 >>> 24;
        switch (cmd) {
        case F3DEX_GBI.G_ENDDL: return;
        case F3DEX_GBI.G_CLEARGEOMETRYMODE: state.gSPClearGeometryMode(w1); break;
        case F3DEX_GBI.G_SETGEOMETRYMODE: state.gSPSetGeometryMode(w1); break;
        case F3DEX_GBI.G_TEXTURE:
            state.gSPTexture(!!(w0 & 0x7F), (w0 >>> 8) & 7, (w0 >>> 11) & 7, w1 >>> 16, w1 & 0xFFFF);
            break;
        case F3DEX_GBI.G_SETTIMG:
            state.gDPSetTextureImage((w0 >>> 21) & 7, (w0 >>> 19) & 3, (w0 & 0x0FFF) + 1, w1);
            break;
        case F3DEX_GBI.G_SETTILE:
            state.gDPSetTile((w0 >>> 21) & 7, (w0 >>> 19) & 3, (w0 >>> 9) & 0x1FF, w0 & 0x1FF,
                (w1 >>> 24) & 7, (w1 >>> 20) & 0x0F, (w1 >>> 18) & 3, (w1 >>> 14) & 0x0F,
                (w1 >>> 10) & 0x0F, (w1 >>> 8) & 3, (w1 >>> 4) & 0x0F, w1 & 0x0F);
            break;
        case F3DEX_GBI.G_LOADTLUT: state.gDPLoadTLUT((w1 >>> 24) & 7, (w1 >>> 14) & 0x3FF); break;
        case F3DEX_GBI.G_LOADBLOCK:
            state.gDPLoadBlock((w1 >>> 24) & 7, (w0 >>> 12) & 0x0FFF, w0 & 0x0FFF, (w1 >>> 12) & 0x0FFF, w1 & 0x0FFF);
            break;
        case F3DEX_GBI.G_SETTILESIZE:
            state.gDPSetTileSize((w1 >>> 24) & 7, (w0 >>> 12) & 0x0FFF, w0 & 0x0FFF, (w1 >>> 12) & 0x0FFF, w1 & 0x0FFF);
            break;
        case F3DEX_GBI.G_VTX: {
            const n = (w0 & 0xFFFF) / 0x10;
            const v0 = (w0 >>> 16) & 0x0F;
            state.gSPVertex(w1, n, v0);
        } break;
        case F3DEX_GBI.G_TRI1:
            state.gSPTri(((w1 >>> 16) & 0xFF) / 10, ((w1 >>> 8) & 0xFF) / 10, (w1 & 0xFF) / 10);
            break;
        case F3DEX_GBI.G_DL:
            runDL_F3D(state, w1);
            // Original F3D uses gDma1p: G_DL_PUSH/G_DL_NOPUSH is the parameter
            // byte in bits 16..23, not the low command byte.
            if (((w0 >>> 16) & 0xFF) === 1) return;
            break;
        case F3DEX_GBI.G_SETOTHERMODE_H: state.gDPSetOtherModeH((w0 >>> 8) & 0xFF, w0 & 0xFF, w1); break;
        case F3DEX_GBI.G_SETOTHERMODE_L: state.gDPSetOtherModeL((w0 >>> 8) & 0xFF, w0 & 0xFF, w1); break;
        case F3DEX_GBI.G_SETCOMBINE: state.gDPSetCombine(w0 & 0x00FFFFFF, w1); break;
        case F3DEX_GBI.G_MOVEMEM: state.gMoveMem?.(w0, w1); break;
        case F3DEX_GBI.G_MOVEWORD: moveWord(state, w0, w1); break;
        case F3DEX_GBI.G_SETPRIMCOLOR:
            state.gDPSetPrimColor?.(w1);
            break;
        case F3DEX_GBI.G_SETENVCOLOR:
            state.gDPSetEnvColor?.(w1);
            break;
        case F3DEX_GBI.G_SETBLENDCOLOR:
            break;
        case F3DEX_GBI.G_SETFOGCOLOR:
            state.gDPSetFogColor?.(w1);
            break;
        case F3DEX_GBI.G_NOOP:
        case F3DEX_GBI.G_POPMTX:
        case F3DEX_GBI.G_CULLDL:
        case F3DEX_GBI.G_RDPFULLSYNC:
        case F3DEX_GBI.G_RDPTILESYNC:
        case F3DEX_GBI.G_RDPPIPESYNC:
        case F3DEX_GBI.G_RDPLOADSYNC:
            break;
        default:
            console.error(`Unknown F3D opcode: ${cmd.toString(16)} at ${hexzero(addr, 8)}+${hexzero(i, 8)}`);
        }
    }
}
