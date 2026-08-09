import { Viewer } from '../src/viewer.js';
import type { SceneGfx, ViewerRenderInput } from '../src/viewer.js';
import type { RSPSharedOutput } from '../src/BanjoKazooie/f3dex.js';
import type { GeometryData } from '../src/DonkeyKong64/render.js';
import { RDPRegressionHash, hashMeshData, hashMeshRenderer, hashTexture, isDK64Renderer } from './game_regression_hash.js';

const sampleCount = 10;
const sampleIntervalMS = 500;
const searchParams = new URLSearchParams(location.search);
const screenshotsEnabled = searchParams.has('screenshot');
const disableFrustumCulling = true;
const disablePortalCulling = true;

class GameRegression {
    private frames = new WeakMap<SceneGfx, number>();
    private sceneIDs = new WeakMap<SceneGfx, string>();
    private overallHash = new RDPRegressionHash();
    private renderer: SceneGfx | null = null;
    private originalTime = 0;
    private awaitingScreenshot = false;
    private originalFrustumContains: ((...args: unknown[]) => boolean) | null = null;
    private originalFrustumContainsSphere: ((...args: unknown[]) => boolean) | null = null;

    public register(scene: SceneGfx): void {
        this.sceneIDs.set(scene, window.__gameRegressionSceneID);
    }

    public beforeRender(scene: SceneGfx, viewerInput: ViewerRenderInput): void {
        if (this.sceneIDs.get(scene) !== window.__gameRegressionSceneID)
            return;
        this.renderer = scene;
        this.originalTime = viewerInput.time;
        const sample = this.frames.get(scene) ?? 0;
        viewerInput.time = sample * sampleIntervalMS;
        scene.setRegressionOptions?.({ disableFrustumCulling, disablePortalCulling });
        if (disableFrustumCulling) {
            const frustum = viewerInput.camera.frustum as unknown as {
                contains: (...args: unknown[]) => boolean;
                containsSphere: (...args: unknown[]) => boolean;
            };
            this.originalFrustumContains = frustum.contains;
            this.originalFrustumContainsSphere = frustum.containsSphere;
            frustum.contains = () => true;
            frustum.containsSphere = () => true;
            if (isDK64Renderer(scene)) {
                for (const geoRenderer of scene.geoRenderers) {
                    geoRenderer.setCullBoundingBox(null);
                    const internal = geoRenderer as unknown as { geometryData: GeometryData };
                    for (const sprite of internal.geometryData.geo.spriteBillboards ?? []) {
                        sprite.maxDistance = undefined;
                        sprite.fadeStartDistance = undefined;
                    }
                }
            }
        }
    }

    public afterRender(scene: SceneGfx, viewerInput: ViewerRenderInput): void {
        if (scene !== this.renderer)
            return;
        const renderer = this.renderer;
        this.renderer = null;
        if (this.originalFrustumContains !== null) {
            const frustum = viewerInput.camera.frustum as unknown as {
                contains: (...args: unknown[]) => boolean;
                containsSphere: (...args: unknown[]) => boolean;
            };
            frustum.contains = this.originalFrustumContains;
            frustum.containsSphere = this.originalFrustumContainsSphere!;
            this.originalFrustumContains = null;
            this.originalFrustumContainsSphere = null;
        }
        const sample = this.frames.get(renderer) ?? 0;
        viewerInput.time = this.originalTime;
        if (sample >= sampleCount || this.awaitingScreenshot)
            return;
        const timeMS = sample * sampleIntervalMS;
        const hash = new RDPRegressionHash();
        const adapter = isDK64Renderer(renderer) ? 'dk64-rdp' : 'load-only';
        hash.string(`noclip game regression ${adapter}`);
        hash.u32(sample);
        hash.u32(timeMS);
        if (isDK64Renderer(renderer)) {
            const tick = Math.floor(timeMS / (1000 / 30));
            hash.u32(renderer.geoDatas.length);
            const sharedOutputs = new Set<RSPSharedOutput>();
            for (const geoData of renderer.geoDatas) {
                hashMeshData(hash, geoData, tick);
                sharedOutputs.add(geoData.geo.sharedOutput);
            }
            hash.u32(sharedOutputs.size);
            for (const sharedOutput of sharedOutputs) {
                const textures = sharedOutput.textureCache.textures;
                hash.u32(textures.length);
                for (const texture of textures)
                    hashTexture(hash, texture);
            }
            hash.u32(renderer.geoRenderers.length);
            for (const geoRenderer of renderer.geoRenderers)
                hashMeshRenderer(hash, geoRenderer);
        } else {
            hash.string(renderer.constructor.name);
        }
        const frameHash = hash.finish();
        const sceneID = this.sceneIDs.get(renderer)!;
        console.log(`GAME_REGRESSION ${JSON.stringify({
            scene: sceneID,
            frame: sample,
            timeMS,
            hash: frameHash,
            adapter,
        })}`);
        this.overallHash.string(sceneID);
        this.overallHash.u32(sample);
        this.overallHash.u32(timeMS);
        this.overallHash.string(frameHash);
        this.frames.set(renderer, sample + 1);
        this.awaitingScreenshot = screenshotsEnabled;
    }

    public acknowledgeScreenshot(): void {
        this.awaitingScreenshot = false;
    }

    public reset(): void {
        this.frames = new WeakMap();
        this.sceneIDs = new WeakMap();
        this.overallHash = new RDPRegressionHash();
        this.awaitingScreenshot = false;
    }

    public finish(): string {
        const hash = this.overallHash.finish();
        console.log(`GAME_REGRESSION_OVERALL ${hash}`);
        return hash;
    }
}

declare global {
    interface Window {
        __gameRegressionFinish?: () => string;
        __gameRegressionAcknowledgeScreenshot?: () => void;
        __gameRegressionReset?: () => void;
        __gameRegressionSceneID: string;
    }
}

const regression = new GameRegression();
window.__gameRegressionSceneID = location.hash.split('/').pop() ?? '';
window.__gameRegressionFinish = () => regression.finish();
window.__gameRegressionAcknowledgeScreenshot = () => regression.acknowledgeScreenshot();
window.__gameRegressionReset = () => regression.reset();
const setScene = Viewer.prototype.setScene;
Viewer.prototype.setScene = function(scene: SceneGfx | null): void {
    if (scene !== null) {
        regression.register(scene);
        const render = scene.render.bind(scene);
        scene.render = (device, viewerInput): void => {
            regression.beforeRender(scene, viewerInput);
            try {
                render(device, viewerInput);
            } finally {
                regression.afterRender(scene, viewerInput);
            }
        };
    }
    setScene.call(this, scene);
};
await import('../src/main.js');
