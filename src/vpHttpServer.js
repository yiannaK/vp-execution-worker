'use strict';

const http = require('node:http');
const { executeVisualEvent } = require('./executor');
const { parseEvent } = require('./worker');
const openApiSpec = require('../openapi/vp-events.openapi.json');

function startVpHttpServer({ port, state, verifyBackendEventJwt, backendClient, program, sandboxClient, log }) {
    const server = http.createServer(async (req, res) => {
        if (req.method === 'GET' && req.url === '/health') {
            return sendJson(res, state.healthy ? 200 : 503, { status: state.healthy ? 'ok' : 'stopping' });
        }
        if (req.method === 'GET' && req.url === '/openapi.json') {
            return sendJson(res, 200, openApiSpec);
        }
        const sandboxCall = /^\/sandbox\/calls\/([0-9a-f-]{36})$/.exec(req.url || '');
        if (req.method === 'POST' && sandboxCall && sandboxClient) {
            try {
                const result = await sandboxClient.handleCall(sandboxCall[1], await readJsonBody(req));
                return sendJson(res, result.status, result.body);
            } catch (error) {
                return sendJson(res, error.statusCode || 400, { message: error.message });
            }
        }
        if (req.method !== 'POST' || req.url !== '/vp/events') {
            return sendJson(res, 404, { message: 'Not found' });
        }
        if (!state.healthy || state.stopping) return sendJson(res, 503, { message: 'VP worker is stopping' });
        if (typeof req.headers.authorization !== 'string' || !req.headers.authorization.startsWith('Bearer ')) {
            return sendJson(res, 401, { message: 'A Bearer service JWT is required' });
        }

        let event;
        let claimed = false;
        try {
            event = parseEvent(await readJsonBody(req));
            verifyBackendEventJwt(req.headers.authorization.slice(7).trim(), event);
            const attemptCount = Number(req.headers['x-vp-attempt-count'] || 1);
            if (!Number.isInteger(attemptCount) || attemptCount < 1 || attemptCount > 1000) {
                const error = new Error('Invalid VP attempt count');
                error.statusCode = 400;
                throw error;
            }
            const claimResult = await backendClient.updateEventStatus(event, 'RUNNING', { attemptCount });
            if (claimResult?.status === 'SUCCEEDED') {
                return sendJson(res, 200, {
                    eventId: event.eventId,
                    status: 'SUCCEEDED',
                    operationCount: Number(claimResult.completedOperationCount || 0),
                    alreadyHandled: true
                });
            }
            claimed = true;
            let result;
            let handlerMode = 'log';
            if (sandboxClient) {
                const plan = await backendClient.getExecutionPlan(event);
                handlerMode = plan.executionMode === 'generated-js' ? 'generated-js' : 'declarative';
                result = plan.executionMode === 'generated-js'
                    ? await sandboxClient.run({ event, plan })
                    : await executeVisualEvent({ event, plan, backendClient });
            } else {
                result = await program.handleEvent({ event, backendClient, log });
            }
            await backendClient.updateEventStatus(event, 'SUCCEEDED', { attemptCount });
            log('event.succeeded', {
                eventId: event.eventId,
                workflowExecutionId: event.workflowExecutionId,
                event: event.event,
                operationCount: result.operationCount,
                mode: handlerMode
            });
            return sendJson(res, 200, { eventId: event.eventId, status: 'SUCCEEDED', ...result });
        } catch (error) {
            log('vp.http_request.failed', { code: error.code || 'VP_HTTP_ERROR', message: error.message });
            if (claimed) {
                try {
                    await backendClient.updateEventStatus(event, error.permanent ? 'FAILED' : 'RETRYING', {
                        error: { code: error.code || 'VP_HTTP_ERROR', message: error.message }
                    });
                    if (error.permanent) {
                        return sendJson(res, 200, { eventId: event.eventId, status: 'FAILED', operationCount: 0 });
                    }
                } catch (statusError) {
                    log('vp.status_update.failed', { eventId: event.eventId, message: statusError.message });
                }
            }
            const status = [400, 401, 413].includes(error.statusCode) ? error.statusCode : 500;
            return sendJson(res, status, {
                message: status === 500 ? 'VP event could not be handled' : error.message
            });
        }
    });
    server.listen(port, '0.0.0.0');
    return server;
}

async function readJsonBody(req) {
    let body = '';
    for await (const chunk of req) {
        body += chunk;
        if (body.length > 32768) {
            const error = new Error('VP event body is too large');
            error.statusCode = 413;
            throw error;
        }
    }
    try {
        return JSON.parse(body);
    } catch (_) {
        const error = new Error('Invalid JSON body');
        error.statusCode = 400;
        throw error;
    }
}

function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

module.exports = { startVpHttpServer };
