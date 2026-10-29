'use strict';

const crypto = require('node:crypto');

function createServiceJwtSigner(options = {}) {
    const privateKey = crypto.createPrivateKey(options.privateKey);
    if (privateKey.asymmetricKeyType !== 'rsa' || Number(privateKey.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
        throw new Error('JWT private key must be an RSA key of at least 2048 bits');
    }
    const keyId = required(options.keyId, 'JWT key id');
    const issuer = options.issuer || 'vp-runner';
    const subject = options.subject || 'vp-runner-production';
    const audience = options.audience || 'workflow-backend';
    const lifetimeSeconds = Number(options.lifetimeSeconds || 60);
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 10 || lifetimeSeconds > 120) {
        throw new Error('JWT lifetime must be between 10 and 120 seconds');
    }

    return function signServiceJwt({ operation, eventId, workflowExecutionId }) {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT', kid: keyId };
        const payload = {
            iss: issuer,
            sub: subject,
            aud: audience,
            tokenType: 'vp-service',
            jti: crypto.randomUUID(),
            iat: now,
            nbf: now,
            exp: now + lifetimeSeconds,
            operation,
            eventId,
            workflowExecutionId
        };
        const encodedHeader = encodeJson(header);
        const encodedPayload = encodeJson(payload);
        const signingInput = `${encodedHeader}.${encodedPayload}`;
        const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
        return `${signingInput}.${signature}`;
    };
}

function encodeJson(value) {
    return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function required(value, name) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
    return value.trim();
}

module.exports = { createServiceJwtSigner };
