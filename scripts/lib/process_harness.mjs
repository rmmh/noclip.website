import { spawn } from 'node:child_process';

export async function waitForServer(url, child, timeoutMS) {
    const deadline = Date.now() + timeoutMS;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null)
            throw new Error(`Development server exited with status ${child.exitCode}`);
        try {
            const response = await fetch(url);
            if (response.ok)
                return;
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Development server did not become ready: ${lastError}`);
}

export async function runCommand(command, args, cwd) {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => output += chunk);
    child.stderr.on('data', (chunk) => output += chunk);
    const status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    if (status.code !== 0) {
        process.stderr.write(output);
        throw new Error(`${command} ${args.join(' ')} failed (${status.signal ?? status.code})`);
    }
}

export async function pollJSON(url, timeoutMS = 15000) {
    const deadline = Date.now() + timeoutMS;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok)
                return response.json();
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Chrome DevTools did not start: ${lastError}`);
}
