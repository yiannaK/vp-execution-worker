'use strict';

const crypto = require('node:crypto');
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createBackendEventJwtVerifier({ publicKey, keyId }) {
    const key = publicKey?.type === 'public' ? publicKey : crypto.createPublicKey(publicKey);
    if (key.asymmetricKeyType !== 'rsa' || Number(key.asymmetricKeyDetails?.modulusLength || 0) < 2048) {
        throw new Error('Backend event JWT requires an RSA public key of at least 2048 bits');
    }

    return function verifyBackendEventJwt(token, event) {
        if (typeof token !== 'string' || token.split('.').length !== 3) throw unauthorized('Missing service JWT');
        const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
        let header;
        let claims;
        try {
            header = JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8'));
            claims = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
        } catch (_) {
            throw unauthorized('Malformed service JWT');
        }
        if (header.alg !== 'RS256' || header.typ !== 'JWT' || header.kid !== keyId) {
            throw unauthorized('Unsupported service JWT header');
        }
        if (!crypto.verify(
            'RSA-SHA256',
            Buffer.from(`${encodedHeader}.${encodedPayload}`),
            key,
            Buffer.from(encodedSignature, 'base64url')
        )) {
            throw unauthorized('Invalid service JWT signature');
        }
        const now = Math.floor(Date.now() / 1000);
        if (
            claims.iss !== 'workflow-backend' ||
            claims.sub !== 'workflow-backend' ||
            claims.aud !== 'vp-worker' ||
            claims.tokenType !== 'vp-event' ||
            claims.operation !== 'deliverVisualEvent' ||
            !Number.isInteger(claims.iat) ||
            !Number.isInteger(claims.nbf) ||
            !Number.isInteger(claims.exp) ||
            claims.iat > now + 5 ||
            claims.nbf > now + 5 ||
            claims.exp <= now - 5 ||
            claims.exp - claims.iat > 120 ||
            !UUID_FORMAT.test(claims.jti || '') ||
            claims.eventId !== event.eventId ||
            claims.workflowExecutionId !== event.workflowExecutionId
        ) {
            throw unauthorized('Invalid service JWT claims');
        }
        return claims;
    };
}

function unauthorized(message) {
    const error = new Error(message);
    error.statusCode = 401;
    return error;
}

module.exports = { createBackendEventJwtVerifier };
