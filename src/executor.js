'use strict';

const SUPPORTED_OPERATIONS = new Set([
    'pauseExecution',
    'resumeExecution',
    'terminateWorkflowExecution',
    'changeWorkflowExecutionFlag',
    'assignUserToActivity',
    'unassignUserFromActivity'
]);

async function executeVisualEvent({ event, plan, backendClient }) {
    if (plan?.executionMode === 'generated-js') {
        throw executionError('WRONG_WORKER_MODE', 'Generated VP programs require the isolated HTTP sandbox mode');
    }
    if (plan?.workflowExecutionId !== event.workflowExecutionId) {
        throw executionError('PLAN_CONTEXT_MISMATCH', 'Execution plan does not match the event workflow');
    }
    const operations = plan?.activities?.[event.activityId]?.[event.event];
    if (!Array.isArray(operations)) {
        throw executionError('HANDLER_NOT_FOUND', 'Visual event handler was not found in the execution plan');
    }

    for (const operation of operations) validateOperation(operation);
    for (const [operationIndex, operation] of operations.entries()) {
        const input = evaluateConstantExpression(operation.input.body) || {};
        await backendClient.executeOperation(event, operation.input.operationId, operationIndex, input);
    }

    return { operationCount: operations.length };
}

function validateOperation(operation) {
    if (operation?.type !== 'openapi.request' || !SUPPORTED_OPERATIONS.has(operation?.input?.operationId)) {
        throw executionError('UNSUPPORTED_OPERATION', `Unsupported VP operation: ${operation?.type || '<missing>'}`);
    }
    const responseBranches = Object.values(operation.input.responses || {});
    if (responseBranches.some(branch => Array.isArray(branch) && branch.length > 0) || operation.input.catchAll?.length) {
        throw executionError(
            'UNSUPPORTED_OPERATION',
            'Response branch operations are not supported by the first VP worker version'
        );
    }
}

function evaluateConstantExpression(node) {
    if (node == null) return null;
    if (node.kind === 'literal') return structuredClone(node.value);
    if (node.kind === 'expression' && node.type === 'object.create') {
        return Object.fromEntries(
            (node.input?.properties || []).map(property => [property.name, evaluateConstantExpression(property.value)])
        );
    }
    throw executionError('UNSUPPORTED_INPUT', `Unsupported VP API input expression: ${node.type || '<missing>'}`);
}

function executionError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

module.exports = { executeVisualEvent };
