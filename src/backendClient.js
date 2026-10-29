'use strict';

class BackendClient {
    constructor({ baseUrl, signJwt, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
        this.baseUrl = validateBaseUrl(baseUrl);
        if (typeof signJwt !== 'function') throw new Error('Backend client requires signJwt');
        if (typeof fetchImpl !== 'function') throw new Error('Backend client requires fetch');
        this.signJwt = signJwt;
        this.fetch = fetchImpl;
        this.timeoutMs = Number(timeoutMs);
    }

    async getExecutionPlan(event) {
        return this.request({
            operation: 'getExecutionPlan',
            event,
            method: 'GET',
            path: `/internal/visual-execution/workflow-executions/${encodeURIComponent(event.workflowExecutionId)}/plan`
        });
    }

    async updateEventStatus(event, status, details = {}) {
        return this.request({
            operation: 'updateEventStatus',
            event,
            method: 'POST',
            path: `/internal/visual-execution/events/${encodeURIComponent(event.eventId)}/status`,
            body: { status, ...details }
        });
    }

    async executeOperation(event, operationId, operationIndex, input = {}) {
        const pathName = OPERATION_PATHS[operationId];
        if (!pathName) throw new Error(`Unsupported backend operation: ${operationId}`);
        return this.request({
            operation: operationId,
            event,
            method: 'POST',
            path: `/internal/visual-execution/workflow-executions/${encodeURIComponent(event.workflowExecutionId)}/${pathName}`,
            headers: { 'x-vp-operation-index': String(operationIndex) },
            ...(Object.keys(input).length ? { body: input } : {})
        });
    }

    async request({ operation, event, method, path, body, headers = {} }) {
        const token = this.signJwt({
            operation,
            eventId: event.eventId,
            workflowExecutionId: event.workflowExecutionId
        });
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetch(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    ...headers,
                    authorization: `Bearer ${token}`,
                    accept: 'application/json',
                    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                    'x-correlation-id': event.correlationId
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
                signal: controller.signal
            });
            const responseBody = await parseResponse(response);
            if (!response.ok) {
                const error = new Error(responseBody?.message || `Backend returned HTTP ${response.status}`);
                error.statusCode = response.status;
                error.code = 'BACKEND_REQUEST_FAILED';
                throw error;
            }
            return responseBody;
        } catch (error) {
            if (error?.name === 'AbortError') {
                const timeoutError = new Error('Backend request timed out');
                timeoutError.code = 'BACKEND_TIMEOUT';
                throw timeoutError;
            }
            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }
}

const OPERATION_PATHS = Object.freeze({
    pauseExecution: 'pause',
    resumeExecution: 'resume',
    terminateWorkflowExecution: 'terminate',
    changeWorkflowExecutionFlag: 'change-flag',
    assignUserToActivity: 'assign-user',
    unassignUserFromActivity: 'unassign-user'
});

function validateBaseUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Invalid backend base URL');
    }
    return url.toString().replace(/\/$/, '');
}

async function parseResponse(response) {
    const text = await response.text();
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch (_) {
        return text;
    }
}

module.exports = { BackendClient };
