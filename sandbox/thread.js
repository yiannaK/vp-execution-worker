'use strict';

const vm = require('node:vm');
const { parentPort, workerData } = require('node:worker_threads');

const pending = new Map();
let callId = 0;
let operationIndex = 0;

parentPort.on('message', message => {
    if (message.type !== 'callResult') return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.status >= 500) entry.reject(new Error(message.body?.message || 'Backend request failed'));
    else {
        if (message.status < 400) operationIndex++;
        entry.resolve({ status: message.status, data: message.body });
    }
});

function call(operationId, input = {}) {
    const index = operationIndex;
    return new Promise((resolve, reject) => {
        const id = ++callId;
        pending.set(id, { resolve, reject });
        parentPort.postMessage({ type: 'call', id, request: { operationId, operationIndex: index, input } });
    });
}

const allowed = new Set([
    'pauseExecution', 'resumeExecution', 'terminateWorkflowExecution',
    'changeWorkflowExecutionFlag', 'assignUserToActivity', 'unassignUserFromActivity'
]);

const client = new Proxy(Object.create(null), {
    get(_, operationId) {
        if (!allowed.has(operationId)) return undefined;
        return async (params, body) => {
            if (params?.workflowExecutionId && params.workflowExecutionId !== workerData.event.workflowExecutionId) {
                throw new Error('Workflow execution context mismatch');
            }
            const response = await call(operationId, body || {});
            if (response.status >= 400) {
                const error = new Error(response.data?.message || 'Backend request failed');
                error.response = response;
                throw error;
            }
            return response;
        };
    }
});

const APIs = Object.freeze({
    pause: async () => (await client.pauseExecution()).data,
    resume: async () => (await client.resumeExecution()).data,
    terminate: async () => (await client.terminateWorkflowExecution()).data,
    setExecutionFlag: async executionFlag => (await client.changeWorkflowExecutionFlag(null, { executionFlag })).data,
    assign: async (activityId, userId) => (await client.assignUserToActivity(null, { activityId, userId })).data,
    unassign: async activityId => (await client.unassignUserFromActivity(null, { activityId })).data
});

const context = vm.createContext({
    APIS: APIs,
    $client: client,
    $useDataWithFormat: value => value,
    ctx: Object.freeze({ ...workerData.event }),
    console: Object.freeze({ log: (...args) => parentPort.postMessage({ type: 'log', message: args.map(String).join(' ') }) })
});

(async () => {
    const source = workerData.code;
    if (source.length > 512 * 1024) throw new Error('VP program source is too large');
    new vm.Script(source, { filename: `${workerData.event.workflowExecutionId}.js` })
        .runInContext(context, { timeout: 1000 });
    context.__eventName = workerData.event.event;
    context.__activityId = workerData.event.activityId;
    const promise = new vm.Script('globalThis.__program[__activityId][__eventName](APIS, ctx)', { filename: 'vp-invoke.js' })
        .runInContext(context, { timeout: 1000 });
    await promise;
    parentPort.postMessage({ type: 'done' });
})().catch(error => parentPort.postMessage({ type: 'error', message: error.message }));
