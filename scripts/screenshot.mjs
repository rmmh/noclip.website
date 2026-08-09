#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mat4 } from 'gl-matrix';
import { CDP, option, reservePort, waitForHTTP } from './lib/browser_harness.mjs';

const scene = option('--scene', null);
if (scene === null || !/^[^/]+\/[^/]+$/.test(scene))
    throw new Error('--scene must be a group/scene identifier, such as sm64/thi');
const output = option('--output', `/tmp/${scene.replace('/', '-')}.png`);
const saveState = option('--save-state', null);
const shareData = option('--share-data', null);
const evaluate = option('--evaluate', null);
const waitMs = Number(option('--wait-ms', '12000'));
if (!Number.isFinite(waitMs) || waitMs < 0)
    throw new Error('--wait-ms must be a non-negative number');
const chromePath = option('--chrome', process.env.CHROME ?? 'google-chrome');
const focusArg = option('--focus', null);
const focus = focusArg === null ? null : focusArg.split(',').map(Number);
if (focus !== null && (focus.length !== 3 || focus.some((v) => !Number.isFinite(v))))
    throw new Error('--focus must be x,y,z');
const eyeArg = option('--eye', null);
const explicitEye = eyeArg === null ? null : eyeArg.split(',').map(Number);
if (explicitEye !== null && (explicitEye.length !== 3 || explicitEye.some((v) => !Number.isFinite(v))))
    throw new Error('--eye must be x,y,z');
if (explicitEye !== null && focus === null)
    throw new Error('--eye requires --focus');

const serverPort = await reservePort();
const debugPort = await reservePort();
const profile = await mkdtemp(join(tmpdir(), 'noclip-screenshot-'));
const server = spawn('node_modules/.bin/rsbuild', ['dev', '--host', '127.0.0.1', '--port', String(serverPort), '--log-level', 'error'], { stdio: ['ignore', 'pipe', 'pipe'] });
let serverOutput = '';
server.stdout.on('data', (chunk) => serverOutput += chunk);
server.stderr.on('data', (chunk) => serverOutput += chunk);
const chrome = spawn(chromePath, [
    '--headless=new', '--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
    '--enable-webgl', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
    '--window-size=1280,720', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

try {
    await waitForHTTP(`http://127.0.0.1:${serverPort}/`);
    const version = await (await waitForHTTP(`http://127.0.0.1:${debugPort}/json/version`)).json();
    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => cdp.send(method, params, sessionId);
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    const sceneState = saveState ?? (shareData === null ? null : `ShareData=${shareData}`);
    const sceneHash = sceneState === null ? scene : `${scene};${sceneState}`;
    const sceneURL = `http://127.0.0.1:${serverPort}/?allow-swiftshader#${encodeURIComponent(sceneHash)}`;
    await send('Page.navigate', { url: sceneURL });
    let loaded = null;
    const loadDeadline = Date.now() + 30000;
    while (Date.now() < loadDeadline) {
        const pageState = await send('Runtime.evaluate', {
            expression: `({ href: location.href, hash: decodeURIComponent(location.hash.slice(1)), title: document.title, body: document.body.innerText.slice(0, 500), hasMain: window.main !== undefined, hasCanvas: document.querySelector('canvas') !== null, hasScene: window.main?.viewer?.scene !== null && window.main?.viewer?.scene !== undefined })`,
            returnByValue: true,
        });
        loaded = pageState.result.value ?? null;
        if (loaded?.hasMain && loaded.hasCanvas && loaded.hasScene) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (cdp.errors.length !== 0)
        throw new Error(`browser exception:\n${cdp.errors.join('\n')}`);
    if (server.exitCode !== null)
        throw new Error(`development server exited with status ${server.exitCode}\n${serverOutput}`);
    if (loaded === null || loaded.hash.split(';')[0] !== scene || !loaded.hasMain || !loaded.hasCanvas || !loaded.hasScene)
        throw new Error(`Scene ${scene} did not load: ${JSON.stringify(loaded)}\n${serverOutput}`);
    if (focus !== null) {
        const eye = explicitEye ?? [focus[0] - 260, focus[1] + 180, focus[2] + 260];
        const camera = mat4.targetTo(mat4.create(), eye, [focus[0], focus[1] + 100, focus[2]], [0, 1, 0]);
        await send('Runtime.evaluate', { expression: `window.main.viewer.cameraController = null; window.main.viewer.camera.worldMatrix.set(${JSON.stringify([...camera])}); window.main.viewer.camera.worldMatrixUpdated()` });
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (evaluate !== null) {
        const evaluated = await send('Runtime.evaluate', { expression: evaluate, returnByValue: true, awaitPromise: true });
        if (evaluated.exceptionDetails !== undefined) {
            const description = evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text;
            throw new Error(`--evaluate failed: ${description}`);
        }
        console.log(JSON.stringify(evaluated.result.value));
        await send('Runtime.evaluate', {
            expression: `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
            awaitPromise: true,
        });
    }
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(output, Buffer.from(screenshot.data, 'base64'));
    console.log(output);
    cdp.socket.close();
} finally {
    server.kill('SIGTERM');
    chrome.kill('SIGTERM');
    await Promise.all([server, chrome].map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => child.once('exit', resolve))));
    await rm(profile, { recursive: true, force: true });
}
