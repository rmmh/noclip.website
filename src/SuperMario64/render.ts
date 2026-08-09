import ArrayBufferSlice from '../ArrayBufferSlice.js';
import { decodeTex_RGBA16 } from '../Common/N64/Image.js';
import { DeviceProgram } from '../Program.js';
import { fillVec4 } from '../gfx/helpers/UniformBufferHelpers.js';
import { GfxShaderLibrary } from '../gfx/helpers/GfxShaderLibrary.js';
import { GfxBindingLayoutDescriptor, GfxCompareMode, GfxDevice, GfxFormat, GfxMipFilterMode, GfxProgram, GfxTexFilterMode, GfxTexture, GfxWrapMode, makeTextureDescriptor2D } from '../gfx/platform/GfxPlatform.js';
import { GfxRenderCache } from '../gfx/render/GfxRenderCache.js';
import { GfxRendererLayer, GfxRenderInstManager, makeSortKeyOpaque } from '../gfx/render/GfxRenderInstManager.js';
import { TextureMapping } from '../TextureHolder.js';
import * as Viewer from '../viewer.js';

class SkyboxProgram extends DeviceProgram {
    public static ub_Params = 0;
    public override both = `
layout(std140) uniform ub_Params { vec4 u_Orientation; };
uniform sampler2D u_Texture;
`;
    public override vert = GfxShaderLibrary.makeFullscreenVS('-1', '1');
    public override frag = `
in vec2 v_TexCoord;
void main() {
    vec2 uv = vec2(
        fract(u_Orientation.x + (v_TexCoord.x - 0.5) * u_Orientation.z),
        1.0 - clamp(u_Orientation.y + (v_TexCoord.y - 0.5) * 0.25, 0.0, 1.0)
    );
    gl_FragColor = texture(SAMPLER_2D(u_Texture), uv);
}
`;
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [{ numUniformBuffers: 1, numSamplers: 1 }];

export interface SkyboxRenderer {
    prepareToRender(renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void;
    destroy(device: GfxDevice): void;
}

class SM64SkyboxRenderer implements SkyboxRenderer {
    private gfxProgram: GfxProgram;
    private gfxTexture: GfxTexture;
    private textureMapping = new TextureMapping();

    constructor(device: GfxDevice, cache: GfxRenderCache, segment: ArrayBufferSlice) {
        const src = segment.createDataView();
        const pixels = new Uint8Array(256 * 256 * 4);
        const tilePixels = new Uint8Array(32 * 32 * 4);
        const pointerTableOffset = segment.byteLength - 80 * 4;
        // The last two columns of each ROM row duplicate the first two for wrapping.
        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                const pointer = src.getUint32(pointerTableOffset + (row * 10 + col) * 4);
                decodeTex_RGBA16(tilePixels, src, pointer & 0x00FFFFFF, 32, 32);
                for (let y = 0; y < 32; y++)
                    pixels.set(tilePixels.subarray(y * 128, (y + 1) * 128), ((row * 32 + y) * 256 + col * 32) * 4);
            }
        }
        this.gfxTexture = device.createTexture(makeTextureDescriptor2D(GfxFormat.U8_RGBA_NORM, 256, 256, 1));
        device.setResourceName(this.gfxTexture, 'SM64 Skybox');
        device.uploadTextureData(this.gfxTexture, 0, [pixels]);
        this.textureMapping.gfxTexture = this.gfxTexture;
        this.textureMapping.gfxSampler = cache.createSampler({
            wrapS: GfxWrapMode.Repeat, wrapT: GfxWrapMode.Clamp,
            minFilter: GfxTexFilterMode.Bilinear, magFilter: GfxTexFilterMode.Bilinear,
            mipFilter: GfxMipFilterMode.Nearest, minLOD: 0, maxLOD: 0,
        });
        this.gfxProgram = cache.createProgram(new SkyboxProgram());
    }

    public prepareToRender(manager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        const camera = viewerInput.camera.worldMatrix;
        const forwardX = -camera[8], forwardY = -camera[9], forwardZ = -camera[10];
        // skybox.c: scaledX = 1280 - yaw/65536*1280, then a 320-wide ortho
        // window is sampled. atan2s(z, x) is equivalent to atan2(x, z).
        const gameYaw = Math.atan2(forwardX, forwardZ) / (Math.PI * 2);
        const centerU = 1 - gameYaw + 0.125;
        const pitch = Math.atan2(forwardY, Math.hypot(forwardX, forwardZ));
        // scaledY = 600 + 4*pitchDegrees. The original orthographic window is
        // bottom-origin, while the fullscreen shader flips the decoded texture
        // with `1.0 - v`; account for that flip here. Positive (upward) pitch
        // must sample higher rows of the panorama, not the ocean at its bottom.
        const centerV = 0.5 + pitch / (Math.PI / 2) * 0.375;
        // Widescreen path in create_skybox_ortho_matrix.
        const horizontalSpan = (4 / 3) / (viewerInput.backbufferWidth / viewerInput.backbufferHeight) * 0.25;
        const renderInst = manager.newRenderInst();
        renderInst.setDrawCount(3);
        renderInst.sortKey = makeSortKeyOpaque(GfxRendererLayer.BACKGROUND, this.gfxProgram.ResourceUniqueId);
        renderInst.setVertexInput(null, null, null);
        renderInst.setBindingLayouts(bindingLayouts);
        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setSamplerBindingsFromTextureMappings([this.textureMapping]);
        renderInst.setMegaStateFlags({ depthCompare: GfxCompareMode.Always, depthWrite: false });
        const d = renderInst.allocateUniformBufferF32(SkyboxProgram.ub_Params, 4);
        fillVec4(d, 0, centerU, centerV, horizontalSpan, 0);
        manager.submitRenderInst(renderInst);
    }

    public destroy(device: GfxDevice): void { device.destroyTexture(this.gfxTexture); }
}

export function createSkyboxRenderer(device: GfxDevice, cache: GfxRenderCache, segment: ArrayBufferSlice): SkyboxRenderer {
    return new SM64SkyboxRenderer(device, cache, segment);
}
