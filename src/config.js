'use strict';

const fs = require('node:fs');

function loadConfig(env = process.env) {
    const eventTransport = (env.VP_EVENT_TRANSPORT || 'sqs').toLowerCase();
    if (!['sqs', 'http'].includes(eventTransport)) throw new Error('VP_EVENT_TRANSPORT must be sqs or http');
    return {
        eventTransport,
        awsRegion: eventTransport === 'sqs' ? required(env.AWS_REGION, 'AWS_REGION') : null,
        queueUrl: eventTransport === 'sqs' ? required(env.VP_QUEUE_URL, 'VP_QUEUE_URL') : null,
        deadLetterQueueUrl: eventTransport === 'sqs' ? required(env.VP_DLQ_URL, 'VP_DLQ_URL') : null,
        backendBaseUrl: required(env.VP_BACKEND_BASE_URL, 'VP_BACKEND_BASE_URL'),
        jwtPrivateKey: loadPrivateKey(env),
        jwtKeyId: required(env.VP_JWT_KEY_ID, 'VP_JWT_KEY_ID'),
        jwtIssuer: env.VP_JWT_ISSUER || 'vp-runner',
        jwtSubject: env.VP_JWT_SUBJECT || 'vp-runner-production',
        jwtAudience: env.VP_JWT_AUDIENCE || 'workflow-backend',
        requestTimeoutMs: positiveInteger(env.VP_REQUEST_TIMEOUT_MS, 10000),
        visibilityTimeout: positiveInteger(env.VP_VISIBILITY_TIMEOUT_SECONDS, 60),
        maxAttempts: positiveInteger(env.VP_MAX_ATTEMPTS, 5),
        healthPort: positiveInteger(env.VP_HEALTH_PORT, 9100),
        inboundPublicKey: eventTransport === 'http'
            ? fs.readFileSync(required(env.VP_INBOUND_JWT_PUBLIC_KEY_FILE, 'VP_INBOUND_JWT_PUBLIC_KEY_FILE'), 'utf8')
            : null,
        inboundKeyId: eventTransport === 'http' ? required(env.VP_INBOUND_JWT_KEY_ID, 'VP_INBOUND_JWT_KEY_ID') : null,
        sandboxUrl: eventTransport === 'http' && env.VP_PROGRAM_MODE === 'generated-js'
            ? required(env.VP_SANDBOX_URL, 'VP_SANDBOX_URL')
            : null,
        programDirectory: env.VP_PROGRAM_DIRECTORY || '/tmp/vp-programs'
    };
}

function loadPrivateKey(env) {
    if (env.VP_JWT_PRIVATE_KEY_FILE) return fs.readFileSync(env.VP_JWT_PRIVATE_KEY_FILE, 'utf8');
    return required(env.VP_JWT_PRIVATE_KEY, 'VP_JWT_PRIVATE_KEY or VP_JWT_PRIVATE_KEY_FILE').replace(/\\n/g, '\n');
}

function positiveInteger(value, fallback) {
    if (value == null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${value}`);
    return parsed;
}

function required(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
    return value.trim();
}

module.exports = { loadConfig };
