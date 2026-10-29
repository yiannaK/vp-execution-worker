'use strict';

const http = require('node:http');
const {
    SQSClient,
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand
} = require('@aws-sdk/client-sqs');
const { BackendClient } = require('./backendClient');
const { loadConfig } = require('./config');
const { executeVisualEvent } = require('./executor');
const { createBackendEventJwtVerifier } = require('./inboundServiceJwt');
const { createServiceJwtSigner } = require('./serviceJwt');
const { ProgramFileStore } = require('./programFileStore');
const { SandboxClient } = require('./sandboxClient');
const { startVpHttpServer } = require('./vpHttpServer');
const vpProgram = require('./vpProgram');
const { createMessageProcessor, parseEvent } = require('./worker');

async function main() {
    const config = loadConfig();
    const sqs = config.eventTransport === 'sqs' ? new SQSClient({ region: config.awsRegion }) : null;
    const signJwt = createServiceJwtSigner({
        privateKey: config.jwtPrivateKey,
        keyId: config.jwtKeyId,
        issuer: config.jwtIssuer,
        subject: config.jwtSubject,
        audience: config.jwtAudience
    });
    const backendClient = new BackendClient({
        baseUrl: config.backendBaseUrl,
        signJwt,
        timeoutMs: config.requestTimeoutMs
    });
    const processMessage = createMessageProcessor({ backendClient, executeVisualEvent });
    const sandboxClient = config.sandboxUrl
        ? new SandboxClient({
              baseUrl: config.sandboxUrl,
              backendClient,
              programFileStore: new ProgramFileStore({ directory: config.programDirectory })
          })
        : null;
    const state = { healthy: true, stopping: false };
    const healthServer = config.eventTransport === 'http'
        ? startVpHttpServer({
              port: config.healthPort,
              state,
              verifyBackendEventJwt: createBackendEventJwtVerifier({
                  publicKey: config.inboundPublicKey,
                  keyId: config.inboundKeyId
              }),
              backendClient,
              program: vpProgram,
              sandboxClient,
              log
          })
        : startHealthServer(config.healthPort, state);
    let resolveStop;
    const stopRequested = new Promise(resolve => { resolveStop = resolve; });

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.once(signal, () => {
            state.stopping = true;
            state.healthy = false;
            resolveStop();
        });
    }

    if (config.eventTransport === 'http') {
        log('worker.http_started', { port: config.healthPort, program: sandboxClient ? 'generated-js' : 'src/vpProgram.js' });
        await stopRequested;
        await new Promise(resolve => healthServer.close(resolve));
        log('worker.stopped');
        return;
    }

    log('worker.started', { queueUrl: redactQueueUrl(config.queueUrl) });
    while (!state.stopping) {
        let response;
        try {
            response = await sqs.send(
                new ReceiveMessageCommand({
                    QueueUrl: config.queueUrl,
                    MaxNumberOfMessages: 10,
                    WaitTimeSeconds: 20,
                    VisibilityTimeout: config.visibilityTimeout,
                    AttributeNames: ['ApproximateReceiveCount']
                })
            );
        } catch (error) {
            log('queue.receive_failed', sanitizeError(error));
            await delay(1000);
            continue;
        }

        for (const message of response.Messages || []) {
            if (state.stopping) break;
            await handleMessage({ message, processMessage, backendClient, sqs, config });
        }
    }

    await new Promise(resolve => healthServer.close(resolve));
    sqs.destroy();
    log('worker.stopped');
}

async function handleMessage({ message, processMessage, backendClient, sqs, config }) {
    const attemptCount = Number(message.Attributes?.ApproximateReceiveCount || 1);
    let event;
    try {
        event = parseEvent(message.Body);
        const result = await processMessage(message);
        await deleteMessage(sqs, config.queueUrl, message.ReceiptHandle);
        log('event.succeeded', {
            eventId: event.eventId,
            workflowExecutionId: event.workflowExecutionId,
            event: event.event,
            operationCount: result.result.operationCount,
            attemptCount
        });
    } catch (error) {
        event ||= tryParseEvent(message.Body);
        const terminal = error?.permanent || attemptCount >= config.maxAttempts;
        if (event) {
            try {
                await backendClient.updateEventStatus(event, terminal ? 'DEAD_LETTER' : 'RETRYING', {
                    attemptCount,
                    error: sanitizeError(error)
                });
            } catch (statusError) {
                log('event.status_update_failed', { eventId: event.eventId, ...sanitizeError(statusError) });
            }
        }

        if (terminal) {
            await sqs.send(
                new SendMessageCommand({
                    QueueUrl: config.deadLetterQueueUrl,
                    MessageBody: message.Body,
                    MessageAttributes: message.MessageAttributes,
                    MessageGroupId: event?.workflowExecutionId || 'invalid-messages'
                })
            );
            await deleteMessage(sqs, config.queueUrl, message.ReceiptHandle);
        }
        log('event.failed', {
            eventId: event?.eventId,
            workflowExecutionId: event?.workflowExecutionId,
            event: event?.event,
            attemptCount,
            terminal,
            ...sanitizeError(error)
        });
    }
}

async function deleteMessage(sqs, queueUrl, receiptHandle) {
    await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

function startHealthServer(port, state) {
    const server = http.createServer((req, res) => {
        if (req.method !== 'GET' || req.url !== '/health') {
            res.writeHead(404).end();
            return;
        }
        const statusCode = state.healthy ? 200 : 503;
        res.writeHead(statusCode, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: state.healthy ? 'ok' : 'stopping' }));
    });
    server.listen(port, '0.0.0.0');
    return server;
}

function tryParseEvent(body) {
    try {
        return JSON.parse(body);
    } catch (_) {
        return null;
    }
}

function sanitizeError(error) {
    return {
        code: error?.code || 'VP_EXECUTION_ERROR',
        message: error?.message || 'Visual event execution failed'
    };
}

function redactQueueUrl(queueUrl) {
    try {
        const url = new URL(queueUrl);
        return `${url.origin}/.../${url.pathname.split('/').pop()}`;
    } catch (_) {
        return '<configured>';
    }
}

function log(logEvent, details = {}) {
    console.log(JSON.stringify({ timestamp: new Date().toISOString(), logEvent, ...details }));
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

main().catch(error => {
    log('worker.fatal', sanitizeError(error));
    process.exitCode = 1;
});
