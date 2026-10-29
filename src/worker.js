'use strict';

const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = new Set(['onEnter', 'onStart', 'onAssign', 'onComplete', 'onError']);

function createMessageProcessor({ backendClient, executeVisualEvent }) {
    return async function processMessage(message) {
        const event = parseEvent(message.Body);
        const attemptCount = Number(message.Attributes?.ApproximateReceiveCount || 1);
        const claimedEvent = await backendClient.updateEventStatus(event, 'RUNNING', { attemptCount });
        if (claimedEvent?.status === 'SUCCEEDED') {
            return { event, result: { operationCount: 0, alreadySucceeded: true }, attemptCount };
        }
        const plan = await backendClient.getExecutionPlan(event);
        const result = await executeVisualEvent({ event, plan, backendClient });
        await backendClient.updateEventStatus(event, 'SUCCEEDED', { attemptCount });
        return { event, result, attemptCount };
    };
}

function parseEvent(body) {
    let event;
    try {
        event = typeof body === 'string' ? JSON.parse(body) : body;
    } catch (_) {
        throw invalidMessage('VP event body must be valid JSON');
    }
    for (const field of ['eventId', 'workflowExecutionId', 'activityId', 'correlationId', 'chainId']) {
        if (!UUID_FORMAT.test(event?.[field] || '')) throw invalidMessage(`Invalid ${field}`);
    }
    if (event.contractVersion !== 1) throw invalidMessage('Unsupported event contract version');
    if (!EVENTS.has(event.event)) throw invalidMessage('Unsupported visual event');
    if (!Number.isInteger(event.chainDepth) || event.chainDepth < 0 || event.chainDepth > 32) {
        throw invalidMessage('Invalid visual event chain depth');
    }
    return event;
}

function invalidMessage(message) {
    const error = new Error(message);
    error.code = 'INVALID_VP_EVENT';
    error.statusCode = 400;
    error.permanent = true;
    return error;
}

module.exports = { createMessageProcessor, parseEvent };
