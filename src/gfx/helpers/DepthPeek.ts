
import { fullscreenMegaState } from "./GfxMegaStateDescriptorHelpers.js";
import { GfxShaderLibrary } from "./GfxShaderLibrary.js";
import { GfxDevice, GfxFormat, GfxMipFilterMode, GfxProgram, GfxReadback, GfxSampler, GfxSamplerBinding, GfxSamplerFormatKind, GfxTexFilterMode, GfxTexture, GfxTextureDimension, GfxViewportOrigin, GfxWrapMode } from "../platform/GfxPlatform.js";
import type { GfxRenderCache } from "../render/GfxRenderCache.js";
import { GfxrAttachmentSlot, GfxrGraphBuilder, GfxrRenderTargetDescription, GfxrRenderTargetID } from "../render/GfxRenderGraph.js";
import type { GfxRenderInstManager } from "../render/GfxRenderInstManager.js";
import { preprocessProgram_GLSL } from "../shaderc/GfxShaderCompiler.js";
import { assert, assertExists } from "../../util.js";

export class PeekZResult {
    public triviallyCulled: boolean = false;
    public value: number | null = null;
    public userData: unknown = null!;
}

class PeekZFrame {
    public results: PeekZResult[] = [];
    public readback: GfxReadback;
    public entryX: Float32Array;
    public entryY: Float32Array;
    public entryUserData: unknown[] = [];
    public entryPrepare: (((userData: unknown) => void) | null)[] = [];

    constructor(device: GfxDevice, maxCount: number) {
        const byteCount = maxCount * 0x04;
        this.readback = device.createReadback(byteCount);
        device.setResourceName(this.readback, 'Depth Peek Readback');
        this.entryX = new Float32Array(maxCount);
        this.entryY = new Float32Array(maxCount);
    }

    public destroy(device: GfxDevice): void {
        device.destroyReadback(this.readback);
    }
}

export class PeekZManager {
    private submittedFrames: PeekZFrame[] = [];
    private maxSubmittedFrames: number = 10;
    private currentFrame: PeekZFrame | null = null;
    private resultBuffer: Uint32Array;

    private depthSampler: GfxSampler | null = null;
    private fullscreenCopyProgram: GfxProgram | null = null;

    private colorTargetDesc = new GfxrRenderTargetDescription(GfxFormat.U8_RGBA_NORM);

    constructor(public maxCount: number = 50) {
        this.resultBuffer = new Uint32Array(this.maxCount);
    }

    private returnFrame(device: GfxDevice, frame: PeekZFrame): void {
        frame.results.length = 0;
        frame.destroy(device);
    }

    public newData(dst: PeekZResult, x: number, y: number, userData: unknown = null!, prepare: ((userData: unknown) => void) | null = null): boolean {
        const frame = assertExists(this.currentFrame);

        // Check for trivial result.
        if (x <= -1 || x >= 1 || y <= -1 || y >= 1) {
            dst.triviallyCulled = true;
            return true;
        }

        dst.triviallyCulled = false;

        if (frame.results.length >= this.maxCount)
            return false;

        const idx = frame.results.push(dst) - 1;
        frame.entryX[idx] = x;
        frame.entryY[idx] = y;
        frame.entryUserData[idx] = userData;
        frame.entryPrepare[idx] = prepare;
        return true;
    }

    private ensureCurrentFrame(device: GfxDevice): void {
        assert(this.currentFrame === null);

        this.currentFrame = new PeekZFrame(device, this.maxCount);
    }

    public beginFrame(device: GfxDevice): void {
        this.ensureCurrentFrame(device);
    }

    private ensureResources(cache: GfxRenderCache): void {
        if (this.fullscreenCopyProgram === null) {
            const fullscreenFS = `
uniform sampler2D u_TextureFramebufferDepth;
in vec2 v_TexCoord;

out vec4 o_Output;

void main() {
    uint u = floatBitsToUint(texture(SAMPLER_2D(u_TextureFramebufferDepth), v_TexCoord).r);
    o_Output = vec4(
        float((u >> 24u) & 0xFFu),
        float((u >> 16u) & 0xFFu),
        float((u >> 8u) & 0xFFu),
        float(u & 0xFFu)
    ) / 255.0;
}
`;
            this.fullscreenCopyProgram = cache.createProgramSimple(preprocessProgram_GLSL(
                cache.device.queryVendorInfo(), GfxShaderLibrary.fullscreenVS, fullscreenFS));
        }

        if (this.depthSampler === null) {
            this.depthSampler = cache.createSampler({
                minFilter: GfxTexFilterMode.Point,
                magFilter: GfxTexFilterMode.Point,
                mipFilter: GfxMipFilterMode.Nearest,
                wrapS: GfxWrapMode.Clamp,
                wrapT: GfxWrapMode.Clamp,
                minLOD: 0,
                maxLOD: 100,
            });
        }
    }

    private stealCurrentFrameAndCheck(cache: GfxRenderCache): PeekZFrame | null {
        const device = cache.device;
        const frame = this.currentFrame;
        this.currentFrame = null;

        if (frame === null)
            return null;

        this.ensureResources(cache);

        if (this.submittedFrames.length >= this.maxSubmittedFrames) {
            // Too many frames in flight, discard this one.
            this.returnFrame(device, frame);
            return null;
        }

        if (frame.results.length === 0) {
            // No need to copy if we aren't trying to read.
            this.returnFrame(device, frame);
            return null;
        }

        return frame;
    }

    private submitFramePost(device: GfxDevice, frame: PeekZFrame, colorTexture: GfxTexture, width: number, height: number): void {
        // Now go through and start submitting readbacks on our texture.
        const yScale = (device.queryVendorInfo().viewportOrigin === GfxViewportOrigin.UpperLeft) ? -1 : 1;

        for (let i = 0; i < frame.results.length; i++) {
            // User specifies coordinates in -1 to 1 normalized space (with -1, -1 being the bottom left).
            // Convert to attachment space.
            const attachmentX = (((frame.entryX[i] * 0.5) + 0.5) * width) | 0;
            const attachmentY = (((frame.entryY[i] * yScale * 0.5) + 0.5) * height) | 0;
            device.readPixelFromTexture(frame.readback, i, colorTexture, attachmentX, attachmentY);
        }

        device.submitReadback(frame.readback);
        this.submittedFrames.push(frame);
    }

    public pushPasses(renderInstManager: GfxRenderInstManager, builder: GfxrGraphBuilder, depthTargetID: GfxrRenderTargetID): void {
        const cache = renderInstManager.gfxRenderCache, device = cache.device;
        const frame = this.stealCurrentFrameAndCheck(cache);
        if (frame === null)
            return;

        const depthTargetDesc = builder.getRenderTargetDescription(depthTargetID);
        const width = depthTargetDesc.width, height = depthTargetDesc.height;

        this.colorTargetDesc.setDimensions(width, height, 1);
        const colorTargetID = builder.createRenderTargetID(this.colorTargetDesc, 'Depth Readback Color');

        builder.pushPass((pass) => {
            pass.setDebugName('Depth Readback Copy');
            pass.attachRenderTargetID(GfxrAttachmentSlot.Color0, colorTargetID);
            const resolvedDepthTextureID = builder.resolveRenderTarget(depthTargetID);
            pass.attachResolveTexture(resolvedDepthTextureID);
            pass.addExtraRef(GfxrAttachmentSlot.Color0);
            pass.exec((passRenderer, scope) => {
                for (let i = 0; i < frame.results.length; i++)
                    frame.entryPrepare[i]?.(frame.entryUserData[i]);
                const renderInst = renderInstManager.newRenderInst();
                renderInst.setAllowSkippingIfPipelineNotReady(false);
                renderInst.setGfxProgram(this.fullscreenCopyProgram!);
                renderInst.setMegaStateFlags(fullscreenMegaState);
                renderInst.setBindingLayouts([{
                    numUniformBuffers: 0,
                    numSamplers: 1,
                    samplerEntries: [{
                        dimension: GfxTextureDimension.n2D,
                        formatKind: GfxSamplerFormatKind.UnfilterableFloat,
                    }],
                }]);
                renderInst.setDrawCount(3);
                const depthTexture = scope.getResolveTextureForID(resolvedDepthTextureID);
                const bindings: GfxSamplerBinding[] = [{ gfxTexture: depthTexture, gfxSampler: this.depthSampler }];
                renderInst.setSamplerBindingsFromTextureMappings(bindings);
                renderInst.drawOnPass(cache, passRenderer);
            });

            pass.post((scope) => {
                const colorTexture = assertExists(scope.getRenderTargetTexture(GfxrAttachmentSlot.Color0));
                this.submitFramePost(device, frame, colorTexture, width, height);
            });
        });
    }

    public peekData(device: GfxDevice): void {
        // Resolve the first frame we can.

        for (let i = 0; i < this.submittedFrames.length; i++) {
            const frame = this.submittedFrames[i];
            if (device.queryReadbackFinished(this.resultBuffer, 0, frame.readback)) {
                this.submittedFrames.splice(i, 1);
                // Copy results to clients.
                for (let j = 0; j < frame.results.length; j++) {
                    const result = frame.results[j];
                    const u = this.resultBuffer[j];
                    const bits = ((u & 0xFF) << 24) | ((u & 0xFF00) << 8) |
                        ((u >>> 8) & 0xFF00) | ((u >>> 24) & 0xFF);
                    const bitBuffer = new Uint32Array([bits >>> 0]);
                    result.value = new Float32Array(bitBuffer.buffer)[0];
                    result.userData = frame.entryUserData[j];
                }

                this.returnFrame(device, frame);
            }
        }
    }

    public destroy(device: GfxDevice): void {
        if (this.currentFrame !== null)
            this.currentFrame.destroy(device);
        for (let i = 0; i < this.submittedFrames.length; i++)
            this.submittedFrames[i].destroy(device);
    }
}
