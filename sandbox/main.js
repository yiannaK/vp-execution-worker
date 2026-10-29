'use strict';

const http = require('node:http');
const { Worker } = require('node:worker_threads');

const port = Number(process.env.VP_SANDBOX_PORT || 9200);
const callbackBaseUrl = process.env.VP_HOST_CALLBACK_URL;
if (!callbackBaseUrl) throw new Error('VP_HOST_CALLBACK_URL is required');

http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { status: 'ok' });
    if (req.method !== 'POST' || req.url !== '/execute') return json(res, 404, { message: 'Not found' });
    try {
        const body = await readBody(req);
        if (typeof body.runId !== 'string' || typeof body.code !== 'string' || !body.event) {
            return json(res, 400, { message: 'Invalid execution request' });
        }
        const result = await execute(body);
        return json(res, 200, result);
    } catch (error) {
        return json(res, error.statusCode || 500, { message: error.message });
    }
}).listen(port, '0.0.0.0');

function execute({ runId, code, event }) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(require.resolve('./thread'), {
            workerData: { code, event },
            resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 }
        });
        let settled = false;
        const timeout = setTimeout(() => finish(new Error('VP program timed out')), 10000);
        function finish(error, value) {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            void worker.terminate();
            if (error) reject(error);
            else resolve(value);
        }
        worker.on('message', async message => {
            if (message.type === 'done') return finish(null, { status: 'completed' });
            if (message.type === 'error') return finish(new Error(message.message));
            if (message.type === 'log') {
                console.log(JSON.stringify({ logEvent: 'vp.program.log', eventId: event.eventId,
                    event: event.event, message: String(message.message).slice(0, 500) }));
                return;
            }
            if (message.type !== 'call') return;
            try {
                const response = await fetch(`${callbackBaseUrl}/sandbox/calls/${encodeURIComponent(runId)}`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify(message.request),
                    signal: AbortSignal.timeout(5000)
                });
                const body = await response.json();
                if (!settled) worker.postMessage({ type: 'callResult', id: message.id, status: response.status, body });
            } catch (error) {
                if (!settled) worker.postMessage({ type: 'callResult', id: message.id, status: 502, body: { message: error.message } });
            }
        });
        worker.on('error', error => finish(error));
        worker.on('exit', code => {
            if (!settled) finish(new Error(`VP program worker exited (${code})`));
        });
    });
}

async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) {
            const error = new Error('Execution request is too large');
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch (_) {
        const error = new Error('Invalid JSON');
        error.statusCode = 400;
        throw error;
    }
}

function json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}
