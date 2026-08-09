import { createServer } from 'node:net';

export function option(name, fallback) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : fallback;
}

export async function reservePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

export async function waitForHTTP(url, timeout = 30000) {
    const deadline = Date.now() + timeout;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok)
                return response;
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

export class CDP {
    constructor(url) {
        this.socket = new WebSocket(url);
        this.nextID = 1;
        this.pending = new Map();
        this.listeners = new Map();
        this.errors = [];
    }

    async open() {
        await new Promise((resolve, reject) => {
            this.socket.addEventListener('open', resolve, { once: true });
            this.socket.addEventListener('error', reject, { once: true });
        });
        this.socket.addEventListener('message', ({ data }) => {
            const message = JSON.parse(data);
            if (message.id !== undefined) {
                const pending = this.pending.get(message.id);
                this.pending.delete(message.id);
                if (message.error)
                    pending.reject(new Error(message.error.message));
                else
                    pending.resolve(message.result);
                return;
            }
            if (message.method === 'Runtime.exceptionThrown')
                this.errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
            for (const listener of this.listeners.get(message.method) ?? [])
                listener(message.params, message.sessionId);
        });
    }

    send(method, params = {}, sessionId = undefined) {
        const id = this.nextID++;
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    on(method, listener) {
        const listeners = this.listeners.get(method) ?? [];
        listeners.push(listener);
        this.listeners.set(method, listeners);
    }
}
