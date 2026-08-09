#!/usr/bin/env node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mat4 } from 'gl-matrix';

function option(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

const scene = option('--scene', null);
if (scene === null || !/^[^/]+\/[^/]+$/.test(scene))
    throw new Error('--scene must be a group/scene identifier, such as sm64/thi');
const output = option('--output', `/tmp/${scene.replace('/', '-')}.png`);
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

async function reservePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

async function waitFor(url, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return response;
        } catch (_) {
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${url}`);
}

class CDP {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.id = 0;
        this.pending = new Map();
        this.errors = [];
    }

    async open() {
        await new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, { once: true });
            this.socket.addEventListener('error', reject, { once: true });
        });
        this.socket.addEventListener('message', ({ data }) => {
            const message = JSON.parse(data);
            if (message.id === undefined) {
                if (message.method === 'Runtime.exceptionThrown')
                    this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
                return;
            }
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(message.error.message));
            else pending.resolve(message.result);
        });
    }

    send(method, params = {}) {
        const id = ++this.id;
        this.socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
}

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
    await waitFor(`http://127.0.0.1:${serverPort}/`);
    const version = await (await waitFor(`http://127.0.0.1:${debugPort}/json/version`)).json();
    const cdp = new CDP(version.webSocketDebuggerUrl);
    await cdp.open();
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params = {}) => cdp.send(method, { ...params, sessionId });
    // Flattened sessions put sessionId on the protocol envelope, not in params.
    cdp.send = function(method, params = {}) {
        const id = ++this.id;
        this.socket.send(JSON.stringify({ id, method, params: Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'sessionId')), sessionId: params.sessionId }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    };
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    const sceneURL = `http://127.0.0.1:${serverPort}/?allow-swiftshader#${scene}`;
    await send('Page.navigate', { url: sceneURL });
    await new Promise((resolve) => setTimeout(resolve, 12000));
    if (cdp.errors.length !== 0)
        throw new Error(`browser exception:\n${cdp.errors.join('\n')}`);
    if (server.exitCode !== null)
        throw new Error(`development server exited with status ${server.exitCode}\n${serverOutput}`);
    const pageState = await send('Runtime.evaluate', {
        expression: `({ href: location.href, title: document.title, body: document.body.innerText.slice(0, 500), hasMain: window.main !== undefined, hasCanvas: document.querySelector('canvas') !== null })`,
        returnByValue: true,
    });
    const loaded = pageState.result.value;
    if (!loaded.hasMain || !loaded.hasCanvas || !loaded.href.startsWith(sceneURL))
        throw new Error(`Scene ${scene} did not load: ${JSON.stringify(loaded)}\n${serverOutput}`);
    if (focus !== null) {
        const eye = explicitEye ?? [focus[0] - 260, focus[1] + 180, focus[2] + 260];
        const camera = mat4.targetTo(mat4.create(), eye, [focus[0], focus[1] + 100, focus[2]], [0, 1, 0]);
        await send('Runtime.evaluate', { expression: `window.main.viewer.cameraController = null; window.main.viewer.camera.worldMatrix.set(${JSON.stringify([...camera])}); window.main.viewer.camera.worldMatrixUpdated()` });
        await new Promise((resolve) => setTimeout(resolve, 1000));
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
