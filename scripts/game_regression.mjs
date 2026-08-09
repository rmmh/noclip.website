#!/usr/bin/env node

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CDP, reservePort } from './lib/browser_harness.mjs';
import { expectedWholeGameHashes, parseRegressionCLI } from './lib/regression_cli.mjs';
import { pollJSON, runCommand, waitForServer } from './lib/process_harness.mjs';

const { outputPath, game, screenshotsEnabled, screenshotPath, sceneFilter, chromePath, timeoutMS, runs } = parseRegressionCLI();
const sampleCount = 10;
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

// This is the finite build dependency of `npm run start`. Running it
// separately lets the harness own an Rsbuild server on a collision-free port.
await runCommand('npm', ['run', 'build:wasm-debug'], repositoryRoot);

const serverPort = await reservePort();
const baseURL = `http://127.0.0.1:${serverPort}/`;
const rsbuildPath = join(repositoryRoot, 'node_modules', '.bin', 'rsbuild');
const devServer = spawn(rsbuildPath, [
    'dev', '--config', 'scripts/rsbuild.game_regression.config.ts',
    '--host', '127.0.0.1', '--port', String(serverPort), '--log-level', 'error',
], {
    cwd: repositoryRoot,
    detached: true,
    stdio: 'ignore',
});
await waitForServer(new URL('game_regression.html', baseURL), devServer, timeoutMS);

const profile = await mkdtemp(join(tmpdir(), 'noclip-game-regression-'));
const port = await reservePort();
const chrome = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--use-gl=angle',
    '--use-angle=vulkan',
    '--enable-features=Vulkan',
    '--disable-vulkan-surface',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
], { stdio: 'ignore' });

let cdp;
let nondeterministic = false;
let screenshotNondeterministic = false;
let failed = false;
const screenshotOverall = screenshotsEnabled ? createHash('sha256') : null;
try {
    const version = await pollJSON(`http://127.0.0.1:${port}/json/version`);
    cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId);
    await cdp.send('Page.enable', {}, sessionId);
    if (screenshotsEnabled) {
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: 800,
            height: 600,
            deviceScaleFactor: 1,
            mobile: false,
        }, sessionId);
    }

    const adapterProbe = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
            const gl = document.createElement('canvas').getContext('webgl2');
            if (gl === null)
                return { error: 'ANGLE did not provide a WebGL2 context' };
            const extension = gl.getExtension('WEBGL_debug_renderer_info');
            const renderer = extension === null
                ? gl.getParameter(gl.RENDERER)
                : gl.getParameter(extension.UNMASKED_RENDERER_WEBGL);
            const vendor = extension === null
                ? gl.getParameter(gl.VENDOR)
                : gl.getParameter(extension.UNMASKED_VENDOR_WEBGL);
            return { renderer, vendor };
        })()`,
        returnByValue: true,
    }, sessionId);
    const adapter = adapterProbe.result.value;
    if (adapter.error !== undefined)
        throw new Error(adapter.error);
    if (/swiftshader|llvmpipe|software/i.test(`${adapter.vendor} ${adapter.renderer}`))
        throw new Error(`Refusing software renderer: ${adapter.vendor} / ${adapter.renderer}`);
    console.log(`ANGLE hardware renderer: ${adapter.vendor} / ${adapter.renderer}`);

    let currentResolve;
    let currentReject;
    let currentScene;
    let currentFrames = [];
    let currentScreenshotHashes = [];
    let currentScreenshotOutputPath = null;
    const resolveCurrentScene = () => {
        if (currentFrames.filter(Boolean).length === sampleCount
            && (!screenshotsEnabled || currentScreenshotHashes.filter(Boolean).length === sampleCount))
            currentResolve({ hashes: currentFrames, screenshotHashes: currentScreenshotHashes });
    };
    cdp.on('Runtime.consoleAPICalled', (params, eventSession) => {
        if (eventSession !== sessionId || params.type !== 'log')
            return;
        const value = params.args[0]?.value;
        if (typeof value !== 'string' || !value.startsWith('GAME_REGRESSION ')) {
            if (params.type === 'error' || params.type === 'warning')
                console.error(`[browser ${params.type}] ${params.args.map((arg) => arg.value ?? arg.description).join(' ')}`);
            return;
        }
        const frame = JSON.parse(value.slice('GAME_REGRESSION '.length));
        if (frame.scene !== currentScene)
            return;
        currentFrames[frame.frame] = frame.hash;
        if (!screenshotsEnabled) {
            resolveCurrentScene();
            return;
        }
        void (async () => {
            await cdp.send('Runtime.evaluate', {
                expression: 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
                awaitPromise: true,
            }, sessionId);
            const screenshot = await cdp.send('Page.captureScreenshot', {
                format: 'png',
                fromSurface: true,
            }, sessionId);
            const png = Buffer.from(screenshot.data, 'base64');
            currentScreenshotHashes[frame.frame] = createHash('sha256')
                .update(png)
                .digest('hex');
            if (currentScreenshotOutputPath !== null)
                await writeFile(join(currentScreenshotOutputPath, `${String(frame.frame).padStart(2, '0')}.png`), png);
            await cdp.send('Runtime.evaluate', {
                expression: 'window.__gameRegressionAcknowledgeScreenshot?.()',
            }, sessionId);
            resolveCurrentScene();
        })().catch(currentReject);
    });
    cdp.on('Runtime.exceptionThrown', (params, eventSession) => {
        if (eventSession === sessionId) {
            const details = params.exceptionDetails;
            const error = new Error(details.exception?.description ?? details.text);
            if (currentReject !== undefined)
                currentReject(error);
            else
                console.error(`[browser exception] ${error.message}`);
        }
    });
    cdp.on('Log.entryAdded', (params, eventSession) => {
        if (eventSession === sessionId && params.entry.level === 'error')
            console.error(`[browser ${params.entry.level}] ${params.entry.text}`);
    });
    cdp.on('Network.loadingFailed', (params, eventSession) => {
        if (eventSession === sessionId && currentReject !== undefined)
            console.error(`[browser network] ${params.errorText}`);
    });

    const harnessURL = new URL('game_regression.html', baseURL);
    if (screenshotsEnabled)
        harnessURL.searchParams.set('screenshot', '');
    harnessURL.searchParams.set('disable-frustum-culling', '');
    harnessURL.searchParams.set('disable-portal-culling', '');
    await cdp.send('Page.navigate', { url: harnessURL.href }, sessionId);
    const catalogResult = await cdp.send('Runtime.evaluate', {
        expression: `new Promise((resolve, reject) => {
            const deadline = performance.now() + ${timeoutMS};
            const poll = () => {
                const groups = window.main?.sceneDatabase?.sceneGroups;
                const group = groups?.find((candidate) => typeof candidate === 'object' && candidate.id === ${JSON.stringify(game)});
                if (group !== undefined && window.main.viewer !== undefined && window.main.canvas !== undefined) {
                    resolve(group.sceneDescs
                        .filter((scene) => typeof scene === 'object' && !scene.hidden)
                        .map((scene) => ({ id: scene.id, name: scene.name })));
                } else if (performance.now() >= deadline) {
                    reject(new Error('Scene group not found: ' + ${JSON.stringify(game)}
                        + '; main=' + typeof window.main + '; body=' + document.body.innerText.slice(0, 300)));
                } else {
                    setTimeout(poll, 50);
                }
            };
            poll();
        })`,
        awaitPromise: true,
        returnByValue: true,
    }, sessionId);
    if (catalogResult.exceptionDetails !== undefined)
        throw new Error(catalogResult.exceptionDetails.exception?.description ?? catalogResult.exceptionDetails.text);
    let scenes = catalogResult.result.value;
    if (!Array.isArray(scenes))
        throw new Error(`Could not enumerate scenes for ${game}`);
    if (sceneFilter !== null)
        scenes = scenes.filter((scene) => scene.id.toLowerCase() === sceneFilter.toLowerCase());
    if (scenes.length === 0)
        throw new Error(`No scenes found for ${game}${sceneFilter === null ? '' : ` matching ${sceneFilter}`}`);

    const runScene = async (scene, run) => {
        currentScene = scene.id;
        currentFrames = [];
        currentScreenshotHashes = [];
        currentScreenshotOutputPath = screenshotPath !== null && run === 0
            ? join(screenshotPath, `${scene.id}-${scene.name.replaceAll(/[^A-Za-z0-9]+/g, '-')}`)
            : null;
        if (currentScreenshotOutputPath !== null)
            await mkdir(currentScreenshotOutputPath, { recursive: true });
        const frames = new Promise((resolve, reject) => {
            currentResolve = resolve;
            currentReject = reject;
        });
        await cdp.send('Runtime.evaluate', {
            expression: `window.__gameRegressionSceneID = ${JSON.stringify(scene.id)}; window.main.loadSceneById(${JSON.stringify(game)}, ${JSON.stringify(scene.id)}, null)`,
        }, sessionId);
        let timeout;
        try {
            return await Promise.race([
                frames,
                new Promise((_, reject) => {
                    timeout = setTimeout(
                        () => reject(new Error(
                            `Timed out after ${timeoutMS}ms (${currentFrames.filter(Boolean).length}/${sampleCount} samples)`,
                        )), timeoutMS,
                    );
                }),
            ]);
        } finally {
            clearTimeout(timeout);
        }
    };

    if (screenshotsEnabled) {
        await runScene(scenes[0], -1);
        await cdp.send('Runtime.evaluate', {
            expression: 'window.__gameRegressionReset?.()',
        }, sessionId);
    }

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const started = new Date().toISOString();
        let record;
        try {
            const allHashes = [];
            const allScreenshotHashes = [];
            for (let run = 0; run < runs; run++) {
                const result = await runScene(scene, run);
                allHashes.push(result.hashes);
                if (screenshotsEnabled)
                    allScreenshotHashes.push(result.screenshotHashes);
            }
            const hashes = allHashes[0];
            const deterministic = allHashes.every((candidate) =>
                candidate.every((hash, frame) => hash === hashes[frame]));
            nondeterministic ||= !deterministic;
            record = {
                scene: scene.id,
                name: scene.name,
                hashes,
                deterministic,
                ...(deterministic ? {} : { runs: allHashes }),
                started,
            };
            if (!deterministic)
                console.error(`${scene.id} NONDETERMINISTIC ${allHashes.map((run) => run.join(' ')).join(' / ')}`);
            if (screenshotsEnabled) {
                const screenshotHashes = allScreenshotHashes[0];
                const screenshotDeterministic = allScreenshotHashes.every((candidate) =>
                    candidate.every((hash, frame) => hash === screenshotHashes[frame]));
                screenshotNondeterministic ||= !screenshotDeterministic;
                for (let frame = 0; frame < screenshotHashes.length; frame++)
                    screenshotOverall.update(`${scene.id}\0${frame}\0${screenshotHashes[frame]}\n`);
                Object.assign(record, {
                    screenshotHashes,
                    screenshotDeterministic,
                    ...(screenshotDeterministic ? {} : { screenshotRuns: allScreenshotHashes }),
                });
                if (!screenshotDeterministic)
                    console.error(`${scene.id} SCREENSHOT NONDETERMINISTIC ${allScreenshotHashes.map((run) => run.join(' ')).join(' / ')}`);
            }
        } catch (error) {
            failed = true;
            record = { scene: scene.id, name: scene.name, error: String(error), started };
            console.error(`${scene.id} ${record.error}`);
        }
        await appendFile(outputPath, `${JSON.stringify(record)}\n`);
    }
    const overall = await cdp.send('Runtime.evaluate', {
        expression: `window.__gameRegressionFinish?.()`,
        returnByValue: true,
    }, sessionId);
    const finalHash = overall.result.value;
    if (typeof finalHash !== 'string')
        throw new Error('regression.ts did not produce an overall hash');
    if (!nondeterministic && !failed)
        console.log(`${game} LOAD/RENDER OK ${scenes.length} scenes x ${runs} runs x ${sampleCount} samples`);
    console.log(`${game} RENDER OVERALL ${finalHash}`);
    const expectedHash = sceneFilter === null ? expectedWholeGameHashes.get(game) : undefined;
    if (expectedHash !== undefined && finalHash !== expectedHash) {
        failed = true;
        console.error(`${game} RENDER REGRESSION expected ${expectedHash}, got ${finalHash}`);
    }
    await appendFile(outputPath, `${JSON.stringify({
        type: 'overall',
        game,
        hash: finalHash,
        scenes: scenes.length,
        deterministic: !nondeterministic && !failed,
        cullingDisabled: true,
        ...(expectedHash === undefined ? {} : { expectedHash, matchesExpected: finalHash === expectedHash }),
    })}\n`);
    if (screenshotsEnabled) {
        const finalScreenshotHash = screenshotOverall.digest('hex');
        if (!screenshotNondeterministic && !failed)
            console.log(`${game} SCREENSHOT OK ${scenes.length} scenes x ${runs} runs x ${sampleCount} samples`);
        console.log(`${game} SCREENSHOT OVERALL ${finalScreenshotHash}`);
        await appendFile(outputPath, `${JSON.stringify({
            type: 'screenshot-overall',
            game,
            hash: finalScreenshotHash,
            scenes: scenes.length,
            deterministic: !screenshotNondeterministic && !failed,
        })}\n`);
    }
} finally {
    cdp?.socket.close();
    if (chrome.exitCode === null) {
        const chromeExited = new Promise((resolve) => chrome.once('exit', resolve));
        chrome.kill('SIGTERM');
        await Promise.race([
            chromeExited,
            new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
    }
    if (devServer.pid !== undefined) {
        try {
            process.kill(-devServer.pid, 'SIGTERM');
        } catch (error) {
            if (error.code !== 'ESRCH')
                throw error;
        }
    }
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

if (nondeterministic || (screenshotsEnabled && screenshotNondeterministic) || failed)
    process.exitCode = 1;
