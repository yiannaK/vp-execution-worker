'use strict';

const crypto = require('node:crypto');

const SUPPORTED_OPERATIONS = new Set([
    'pauseExecution', 'resumeExecution', 'terminateWorkflowExecution',
    'changeWorkflowExecutionFlag', 'assignUserToActivity', 'unassignUserFromActivity'
]);

class SandboxClient {
    constructor({ baseUrl, backendClient, programFileStore, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
        this.baseUrl = new URL(baseUrl);
        if (!['http:', 'https:'].includes(this.baseUrl.protocol)) throw new Error('Invalid sandbox URL');
        this.backendClient = backendClient;
        this.programFileStore = programFileStore;
        this.timeoutMs = timeoutMs;
        this.fetch = fetchImpl;
        this.activeRuns = new Map();
    }

    async run({ event, plan }) {
        if (plan?.workflowExecutionId !== event.workflowExecutionId) throw new Error('VP program snapshot does not match the workflow execution');
        if (this.activeRuns.size >= 4) throw new Error('VP sandbox concurrency limit exceeded');
        if (!this.programFileStore) throw new Error('VP program file store is required');
        const artifact = await this.programFileStore.materialize(plan);
        if (typeof plan.programs?.[event.activityId] !== 'string') {
            throw new Error('VP activity program is missing from the execution snapshot');
        }
        if (plan.executionMode !== 'generated-js') throw new Error('Execution plan is not in generated JS mode');
        const operations = plan.activities?.[event.activityId]?.[event.event];
        if (!Array.isArray(operations)) throw new Error('VP event handler was not found');
        const allowedOperations = collectOperations([operations, plan.procedures?.[event.activityId]]);
        const runId = crypto.randomUUID();
        const run = { event, allowedOperations, nextIndex: 0, busy: false,
            transientFailure: null, permanentFailure: null };
        this.activeRuns.set(runId, run);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await this.fetch(new URL('/execute', this.baseUrl), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ runId, event, code: artifact.source }),
                signal: controller.signal
            });
            const result = await response.json();
            if (run.transientFailure) throw run.transientFailure;
            if (run.permanentFailure) throw run.permanentFailure;
            if (!response.ok) {
                const error = new Error(result.message || `Sandbox returned ${response.status}`);
                error.permanent = true;
                throw error;
            }
            return { operationCount: run.nextIndex };
        } finally {
            clearTimeout(timeout);
            this.activeRuns.delete(runId);
        }
    }

    async handleCall(runId, request) {
        const run = this.activeRuns.get(runId);
        if (!run) return { status: 404, body: { message: 'Unknown sandbox run' } };
        const { operationId, operationIndex, input } = request || {};
        if (!SUPPORTED_OPERATIONS.has(operationId) || !run.allowedOperations.has(operationId)) {
            run.permanentFailure = permanentError('Operation is not allowed in this event handler');
            return { status: 403, body: { message: 'Operation is not allowed in this event handler' } };
        }
        if (!Number.isInteger(operationIndex) || operationIndex !== run.nextIndex || run.busy) {
            run.permanentFailure = permanentError('Operations must be sequential');
            return { status: 409, body: { message: 'Operations must be sequential' } };
        }
        run.busy = true;
        try {
            const result = await this.backendClient.executeOperation(run.event, operationId, operationIndex, input || {});
            run.nextIndex++;
            return { status: 200, body: { ...result, alreadyApplied: false } };
        } catch (error) {
            if (!error.statusCode || Number(error.statusCode) >= 500) run.transientFailure = error;
            return { status: Number(error.statusCode) || 502, body: { message: error.message } };
        } finally {
            run.busy = false;
        }
    }
}

function permanentError(message) {
    const error = new Error(message);
    error.permanent = true;
    return error;
}

function collectOperations(value, found = new Set()) {
    if (!value || typeof value !== 'object') return found;
    if (Array.isArray(value)) {
        for (const child of value) collectOperations(child, found);
        return found;
    }
    if (value.kind === 'statement') {
        if (value.type === 'openapi.request') found.add(value.input?.operationId);
        const legacy = {
            'workflow.pause': 'pauseExecution',
            'workflow.resume': 'resumeExecution',
            'workflow.terminate': 'terminateWorkflowExecution',
            'workflow.setFlag': 'changeWorkflowExecutionFlag',
            'activity.assign': 'assignUserToActivity',
            'activity.unassign': 'unassignUserFromActivity'
        }[value.type];
        if (legacy) found.add(legacy);
    }
    for (const child of Object.values(value)) collectOperations(child, found);
    return found;
}

module.exports = { SandboxClient, collectOperations };
