import { mat4, vec4 } from 'gl-matrix';
import * as Viewer from '../viewer.js';
import { Color, colorNewFromRGBA } from '../Color.js';
import { GfxRendererLayer } from '../gfx/render/GfxRenderInstManager.js';
import * as RDP from '../Common/N64/RDP.js';
import { TextFilt } from '../Common/N64/Image.js';
import { RSP_Geometry, Vertex } from '../BanjoKazooie/f3dex.js';
import { DrawCall } from './render.js';
import { MonitorCommand } from './constants.js';
import type { EnvironmentArchive } from './archive.js';
import type { GoldenEyeDrawCall } from './display_list.js';

const monitorTextureIDs = [
    2187, 2188, 2189, 2190, 2191, 2192, 2193, 2194, 2195, 2196, 2197, 1185,
    2198, 2199, 1186, 1187, 2200, 582, 583, 584, 2201, 2202, 2203, 2204, 581,
    2205, 2206, 2227, 2223, 2224, 2225, 2226, 2219, 2220, 2221, 2222, 2218,
    2207, 2208, 2209, 2210, 2211, 2212, 2213, 2214, 2215, 2216, 2217, 2263, 837,
];

const environmentViewScratch = mat4.create();
const environmentShearScratch = mat4.create();
const environmentWorldScratch = mat4.create();
const environmentInverseProjectionScratch = mat4.create();
const environmentRayScratch = vec4.create();
const environmentWorldRayScratch = vec4.create();
const doorHingeScratch = mat4.create();

export interface Environment {
    // Values passed to viSetZRange / gSPFogPosition by fogLoadCurrentEnvironment.
    // These are converted to eye-space distances below; NearFog is unrelated
    // gameplay visibility data and deliberately is not represented here.
    blend?: number;
    far: number;
    fogMin?: number;
    fogMax?: number;
    sky: Color;
    concavity: number;
    cloud?: { height: number; color: Color; textureID: number };
    water?: { height: number; color: Color; textureID: number };
}

export function getFogRange(environment: Environment, visibilityScale: number): [number, number] | null {
    if (environment.blend === undefined || environment.far <= environment.blend)
        return null;
    const near = environment.blend / visibilityScale;
    const far = environment.far / visibilityScale;
    const fogMin = (environment.fogMin ?? 996) / 1000;
    const fogMax = (environment.fogMax ?? 1000) / 1000;
    if (fogMax <= fogMin)
        return null;

    // fog.c builds alpha = A / eyeZ + B from the perspective Z range and
    // gSPFogPosition intensities. Invert it at alpha 0 and 1 so noclip's
    // linear eye-distance fog reaches the same two endpoints.
    const scale = 128 / (fogMax - fogMin);
    const bias = 256 * (0.5 - fogMin) / (fogMax - fogMin);
    const a = (far * -scale * (near + 1) / (far - near)) / 255;
    const b = (scale * (far + 1) / (far - near) + bias) / 255;
    return [-a / b, a / (1 - b)];
}

function archivedColor(v: number[]): Color {
    return colorNewFromRGBA(v[0], v[1], v[2], v[3]);
}

export function environmentFromArchive(source: EnvironmentArchive): Environment {
    const skyWaterTextureIDs = [2228, 1508, 1509];
    return {
        blend: source.FogEnabled ? source.Blend : undefined,
        far: source.Far,
        fogMin: source.FogMin,
        fogMax: source.FogMax,
        sky: archivedColor(source.Sky),
        concavity: source.WaterConcavity,
        cloud: source.CloudEnabled ? { height: source.CloudHeight, color: archivedColor(source.CloudColor), textureID: skyWaterTextureIDs[source.SkyImageID] } : undefined,
        water: source.WaterEnabled ? { height: source.WaterHeight, color: archivedColor(source.WaterColor), textureID: skyWaterTextureIDs[source.WaterImageID] } : undefined,
    };
}

export class MonitorAnimator {
    public textureID = monitorTextureIDs[0];
    public xmid = 0.5; public ymid = 0.5;
    public xscale = 1; public yscale = 1;
    public rotation = 0;
    public red = 1; public green = 1; public blue = 1; public alpha = 1;
    public displayXmid = 0.5; public displayYmid = 0.5;
    public displayXscale = 1; public displayYscale = 1;
    public displayRed = 1; public displayGreen = 1; public displayBlue = 1; public displayAlpha = 1;
    private wordOffset: number;
    private currentListWordOffset: number;
    private pause = -1;
    private stopped = false;
    private simulatedTicks = 0;
    private rng: number;
    private xTransition: number[] | null = null;
    private yTransition: number[] | null = null;
    private xsTransition: number[] | null = null;
    private ysTransition: number[] | null = null;
    private colorTransition: number[] | null = null;

    constructor(private commands: DataView, rootByteOffset: number, seed: number) {
        this.currentListWordOffset = this.wordOffset = rootByteOffset >>> 2;
        this.rng = seed >>> 0;
    }

    private word(index: number): number { return this.commands.getUint32(index * 4); }
    private signedWord(index: number): number { return this.commands.getInt32(index * 4); }
    private pointerWordOffset(address: number): number { return (address - 0x80030B74) >>> 2; }
    private random16(): number {
        this.rng = (Math.imul(this.rng, 1664525) + 1013904223) >>> 0;
        return this.rng >>> 16;
    }
    private transition(current: number, target: number, duration: number): number[] {
        return [current, target, 0, duration <= 0 ? 1 : 1 / duration];
    }
    private processCommands(): void {
        for (let guard = 0; guard < 256 && !this.stopped; guard++) {
            if (this.wordOffset * 4 >= this.commands.byteLength) { this.stopped = true; return; }
            const command = this.word(this.wordOffset);
            const arg1 = this.signedWord(this.wordOffset + 1);
            const arg2 = this.word(this.wordOffset + 2);
            switch (command) {
            case MonitorCommand.ResetPosition: this.xTransition = this.yTransition = null; this.wordOffset++; break;
            case MonitorCommand.MoveX: this.xTransition = this.transition(this.xmid, this.xmid + arg1 / 1024, arg2); this.wordOffset += 3; break;
            case MonitorCommand.MoveY: this.yTransition = this.transition(this.ymid, this.ymid + arg1 / 1024, arg2); this.wordOffset += 3; break;
            case MonitorCommand.SetX: this.xTransition = this.transition(this.xmid, arg1 / 1024, arg2); this.wordOffset += 3; break;
            case MonitorCommand.SetY: this.yTransition = this.transition(this.ymid, arg1 / 1024, arg2); this.wordOffset += 3; break;
            case MonitorCommand.ScaleX: this.xsTransition = this.transition(this.xscale, arg1 / 1024, arg2); this.wordOffset += 3; break;
            case MonitorCommand.ScaleY: this.ysTransition = this.transition(this.yscale, arg1 / 1024, arg2); this.wordOffset += 3; break;
            case MonitorCommand.SetImage: this.textureID = monitorTextureIDs[arg1] ?? monitorTextureIDs[0]; this.wordOffset += 2; break;
            case MonitorCommand.Pause:
                if (this.pause < 0) this.pause = arg1;
                return;
            case MonitorCommand.Jump:
                this.currentListWordOffset = this.wordOffset = this.pointerWordOffset(this.word(this.wordOffset + 1));
                break;
            case MonitorCommand.RandomJump:
                if (this.random16() < arg2)
                    this.currentListWordOffset = this.wordOffset = this.pointerWordOffset(this.word(this.wordOffset + 1));
                else this.wordOffset += 3;
                break;
            case MonitorCommand.Restart: this.wordOffset = this.currentListWordOffset; break;
            case MonitorCommand.Stop: this.stopped = true; return;
            case MonitorCommand.SetColor: {
                const rgba = this.word(this.wordOffset + 1);
                this.colorTransition = [this.red, this.green, this.blue, this.alpha,
                    ((rgba >>> 24) & 0xFF) / 255, ((rgba >>> 16) & 0xFF) / 255,
                    ((rgba >>> 8) & 0xFF) / 255, (rgba & 0xFF) / 255, 0, arg2 <= 0 ? 1 : 1 / arg2];
                this.wordOffset += 3;
                break;
            }
            case MonitorCommand.SetRotation: this.rotation = arg1 * Math.PI * 2 / 65535; this.wordOffset += 2; break;
            case MonitorCommand.Rotate:
                this.rotation = (this.rotation + arg1 * Math.PI * 2 / 65535) % (Math.PI * 2);
                if (this.rotation < 0) this.rotation += Math.PI * 2;
                this.wordOffset += 2;
                break;
            default: this.stopped = true; return;
            }
        }
    }
    private updateTransition(value: number, transition: number[] | null): [number, number[] | null] {
        if (transition === null) return [value, null];
        transition[2] = Math.min(1, transition[2] + transition[3]);
        return [transition[0] + (transition[1] - transition[0]) * transition[2], transition[2] >= 1 ? null : transition];
    }
    private tick(): void {
        if (!this.stopped) {
            if (this.pause >= 0) {
                this.pause -= 1;
                if (this.pause < 0) this.wordOffset += 2;
            }
            if (this.pause < 0) this.processCommands();
        }
        [this.xmid, this.xTransition] = this.updateTransition(this.xmid, this.xTransition);
        [this.ymid, this.yTransition] = this.updateTransition(this.ymid, this.yTransition);
        [this.xscale, this.xsTransition] = this.updateTransition(this.xscale, this.xsTransition);
        [this.yscale, this.ysTransition] = this.updateTransition(this.yscale, this.ysTransition);
        if (this.colorTransition !== null) {
            const t = this.colorTransition;
            t[8] = Math.min(1, t[8] + t[9]);
            this.red = t[0] + (t[4] - t[0]) * t[8]; this.green = t[1] + (t[5] - t[1]) * t[8];
            this.blue = t[2] + (t[6] - t[2]) * t[8]; this.alpha = t[3] + (t[7] - t[3]) * t[8];
            if (t[8] >= 1) this.colorTransition = null;
        }
    }
    public update(timeMs: number): void {
        const exactTicks = Math.max(0, timeMs * 60 / 1000);
        const targetTicks = Math.floor(exactTicks);
        // Viewer time is monotonic. Replaying integral game ticks exactly also
        // makes animation speed independent of the display refresh rate.
        while (this.simulatedTicks < targetTicks) { this.tick(); this.simulatedTicks++; }
        const fraction = exactTicks - targetTicks;
        const preview = (value: number, transition: number[] | null): number => transition === null ? value
            : transition[0] + (transition[1] - transition[0]) * Math.min(1, transition[2] + transition[3] * fraction);
        this.displayXmid = preview(this.xmid, this.xTransition);
        this.displayYmid = preview(this.ymid, this.yTransition);
        this.displayXscale = preview(this.xscale, this.xsTransition);
        this.displayYscale = preview(this.yscale, this.ysTransition);
        if (this.colorTransition === null) {
            this.displayRed = this.red; this.displayGreen = this.green; this.displayBlue = this.blue; this.displayAlpha = this.alpha;
        } else {
            const t = this.colorTransition, f = Math.min(1, t[8] + t[9] * fraction);
            this.displayRed = t[0] + (t[4] - t[0]) * f; this.displayGreen = t[1] + (t[5] - t[1]) * f;
            this.displayBlue = t[2] + (t[6] - t[2]) * f; this.displayAlpha = t[3] + (t[7] - t[3]) * f;
        }
    }
}

export function buildEnvironmentDrawCalls(environment: Environment | undefined, levelScale: number): GoldenEyeDrawCall[] {
    if (environment === undefined)
        return [];
    const result: GoldenEyeDrawCall[] = [];
    const addPlane = (height: number, color: Color, textureID: number, kind: number, uvScale: number): void => {
        const makeVertex = (x: number, z: number): Vertex => {
            const v = new Vertex();
            v.x = x; v.y = height; v.z = z;
            v.tx = x * uvScale; v.ty = z * uvScale;
            v.c0 = color.r; v.c1 = color.g; v.c2 = color.b; v.a = color.a;
            return v;
        };
        // skyRender produces at most a small horizon-clipped polygon. Reserve
        // six triangles; prepareToRender rewrites these dynamic vertices from
        // the current camera rays every frame and degenerates unused slots.
        const vertices: Vertex[] = [];
        for (let i = 0; i < 18; i++)
            vertices.push(makeVertex(0, 0));
        const drawCall = new DrawCall();
        // skyRender submits direct RDP triangles at the background depth. It
        // neither compares nor updates the scene Z buffer; rooms drawn later
        // cover the effect. Enabling Z here makes separately clipped fan
        // triangles fight at the far plane and appear as detached wedges.
        drawCall.SP_GeometryMode = RSP_Geometry.G_SHADE | RSP_Geometry.G_SHADING_SMOOTH;
        drawCall.DP_OtherModeH = TextFilt.G_TF_BILERP << RDP.OtherModeH_Layout.G_MDSFT_TEXTFILT;
        drawCall.DP_OtherModeL = RDP.RENDER_MODES.G_RM_AA_OPA_SURF | RDP.RENDER_MODES.G_RM_AA_OPA_SURF2;
        // skyRender: (SHADE - ENVIRONMENT) * TEXEL0 + ENVIRONMENT.
        drawCall.DP_Combine = {
            c0: { a: RDP.CCMUX.SHADE, b: RDP.CCMUX.ENVIRONMENT, c: RDP.CCMUX.TEXEL0, d: RDP.CCMUX.ENVIRONMENT },
            c1: { a: RDP.CCMUX.SHADE, b: RDP.CCMUX.ENVIRONMENT, c: RDP.CCMUX.TEXEL0, d: RDP.CCMUX.ENVIRONMENT },
            a0: { a: RDP.ACMUX.ZERO, b: RDP.ACMUX.ZERO, c: RDP.ACMUX.ZERO, d: RDP.ACMUX.SHADE },
            a1: { a: RDP.ACMUX.ZERO, b: RDP.ACMUX.ZERO, c: RDP.ACMUX.ZERO, d: RDP.ACMUX.SHADE },
        };
        drawCall.DP_EnvColor = environment.sky;
        if (kind === -3) {
            // skySetupWaterMaterial uses the same 32px image on two tiles and
            // the cartridge combine word FC272C04/1F1093FF to blend them.
            drawCall.DP_OtherModeH |= RDP.OtherModeH_CycleType.G_CYC_2CYCLE << RDP.OtherModeH_Layout.G_MDSFT_CYCLETYPE;
            drawCall.DP_Combine = RDP.decodeCombineParams(0xFC272C04, 0x1F1093FF);
        }
        drawCall.vertices = vertices;
        drawCall.vertexCount = vertices.length;
        // skyChooseCloudVtxColour / sub_GAME_7F093FA4 evaluate colour from
        // each camera ray every frame. Keep this buffer writable so the same
        // horizon fade can be evaluated below after the camera has moved.
        drawCall.dynamicGeometry = true;
        drawCall.SP_TextureState.set(true, 0, 0, 1, 1);
        result.push({ drawCall, textureID, detailTextureID: kind === -3 ? textureID : -1, textureType: kind === -3 ? 1 : 0, textureSMode: 0, textureTMode: 0, modelID: kind });
    };
    if (environment.cloud !== undefined)
        addPlane(environment.cloud.height * levelScale, environment.cloud.color, environment.cloud.textureID, -2, 0.1 / 32);
    if (environment.water !== undefined)
        addPlane(environment.water.height * levelScale, environment.water.color, environment.water.textureID, -3, 1 / 32);
    return result;
}

export function updateEnvironmentPolygon(drawCall: DrawCall, viewerInput: Viewer.ViewerRenderInput,
        planeHeight: number, effectColor: Color, skyColor: Color, cloud: boolean, concavity: number): void {
    if (mat4.invert(environmentInverseProjectionScratch, viewerInput.camera.projectionMatrix) === null)
        return;
    const sign = cloud ? 1 : -1;
    const yOffset = 2 * concavity / 240;
    const ray = (x: number, y: number): [number, number, number] => {
        // noclip's projection convention has framebuffer Y opposite the NDC
        // coordinates used by the cart's screen-ray helper.
        vec4.set(environmentRayScratch, x, -y + yOffset, 1, 1);
        vec4.transformMat4(environmentRayScratch, environmentRayScratch, environmentInverseProjectionScratch);
        const w = environmentRayScratch[3] || 1;
        vec4.set(environmentWorldRayScratch, environmentRayScratch[0] / w,
            environmentRayScratch[1] / w, environmentRayScratch[2] / w, 0);
        vec4.transformMat4(environmentWorldRayScratch, environmentWorldRayScratch, viewerInput.camera.worldMatrix);
        return [environmentWorldRayScratch[0], environmentWorldRayScratch[1], environmentWorldRayScratch[2]];
    };
    type ClipPoint = { x: number; y: number; dy: number };
    let polygon: ClipPoint[] = [
        { x: -1, y: 1, dy: 0 }, { x: 1, y: 1, dy: 0 },
        { x: 1, y: -1, dy: 0 }, { x: -1, y: -1, dy: 0 },
    ];
    for (const p of polygon)
        p.dy = ray(p.x, p.y)[1];
    const clipped: ClipPoint[] = [];
    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const aInside = sign * a.dy >= 0, bInside = sign * b.dy >= 0;
        if (aInside)
            clipped.push(a);
        if (aInside !== bInside) {
            const t = a.dy / (a.dy - b.dy);
            clipped.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dy: 0 });
        }
    }
    polygon = clipped;
    const cameraY = viewerInput.camera.worldMatrix[13];
    const uvScale = cloud ? 0.1 / 32 : 1 / 32;
    const converted: Vertex[] = polygon.map((p) => {
        const direction = ray(p.x, p.y);
        // The cart substitutes +/-0.01 at the horizon before intersecting and
        // caps the resulting horizontal span to 300000 world units.
        const dy = Math.abs(direction[1]) < 0.000001 ? sign * 0.01 : direction[1];
        let distance = (planeHeight - cameraY) / dy;
        const horizontalRay = Math.hypot(direction[0], direction[2]);
        if (Math.abs(horizontalRay * distance) > 300000)
            distance *= 300000 / Math.abs(horizontalRay * distance);
        const v = new Vertex();
        v.x = direction[0] * distance;
        v.y = planeHeight;
        v.z = direction[2] * distance;
        v.tx = v.x * uvScale;
        v.ty = v.z * uvScale;
        const strength = Math.max(0, Math.min(1, sign * 2 * direction[1] / Math.max(horizontalRay, 0.0001)));
        v.c0 = skyColor.r + effectColor.r * (1 - skyColor.r) * strength;
        v.c1 = skyColor.g + effectColor.g * (1 - skyColor.g) * strength;
        v.c2 = skyColor.b + effectColor.b * (1 - skyColor.b) * strength;
        v.a = 1;
        return v;
    });
    const output = drawCall.vertices;
    let dst = 0;
    for (let i = 1; i + 1 < converted.length && dst + 3 <= output.length; i++) {
        for (const source of [converted[0], converted[i], converted[i + 1]]) {
            const target = output[dst++];
            Object.assign(target, source);
        }
    }
    const degenerate = converted[0] ?? new Vertex();
    while (dst < output.length)
        Object.assign(output[dst++], degenerate);
}

