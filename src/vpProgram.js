'use strict';

// First-stage custom VP program. The request handlers deliberately log instead
// of changing workflow state. Replace them with OpenAPI client calls after the
// backend <-> VP HTTP contract has been verified.
const OPENAPI_OPERATIONS = new Set([
    'pauseExecution',
    'resumeExecution',
    'terminateWorkflowExecution',
    'changeWorkflowExecutionFlag',
    'assignUserToActivity',
    'unassignUserFromActivity'
]);

async function handleEvent({ event, backendClient, log }) {
    // This file is the OpenAPI event handler and an HTTP client of the backend.
    const plan = await backendClient.getExecutionPlan(event);
    if (plan?.executionMode === 'generated-js') {
        throw new Error('Generated-JS execution requires the isolated sandbox worker mode');
    }
    if (plan?.workflowExecutionId !== event.workflowExecutionId) {
        throw new Error('VP execution plan does not match the event');
    }
    const operations = plan.activities?.[event.activityId]?.[event.event];
    if (!Array.isArray(operations)) throw new Error('VP event handler not found');

    log('vp.event.handled', {
        eventId: event.eventId,
        workflowExecutionId: event.workflowExecutionId,
        activityId: event.activityId,
        event: event.event,
        operationCount: operations.length
    });

    for (const [operationIndex, operation] of operations.entries()) {
        const operationId = operation?.input?.operationId;
        if (operation?.type !== 'openapi.request' || !OPENAPI_OPERATIONS.has(operationId)) {
            throw new Error(`Unsupported demo VP operation: ${operationId || '<missing>'}`);
        }
        log('vp.service.request_handled', {
            eventId: event.eventId,
            workflowExecutionId: event.workflowExecutionId,
            activityId: event.activityId,
            event: event.event,
            operationId,
            operationIndex
        });
    }

    return { operationCount: operations.length };
}

module.exports = { handleEvent };
