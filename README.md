# VP Execution Worker

Standalone Visual Programming worker with two development modes. The existing SQS mode executes approved workflow operations through authenticated backend endpoints. The HTTP proof-of-concept mode accepts authenticated events from the backend and runs the custom JavaScript program in `src/vpProgram.js`, which logs each planned OpenAPI operation without changing workflow state.

## HTTP OpenAPI proof of concept

The worker serves `POST /vp/events`, `GET /health`, and `GET /openapi.json` on port 9101. The contract is `openapi/vp-events.openapi.json` and is also served at `/openapi.json`. The backend calls the worker with an RS256 service JWT; the worker verifies it using `vp-backend-events-public.pem`. For each accepted event, `src/vpProgram.js` fetches the execution plan from the backend, finds `activities[activityId][event]`, logs each operation, and reports `SUCCEEDED` through the existing worker-to-backend signed JWT API. The operation itself is **not executed** in this demo mode.

In the worker repository, start the development server with:

```bash
npm run start:http-demo
curl http://localhost:9101/health
```

The local demo requires the ignored key files `vp-runner-private.pem` and `vp-backend-events-public.pem`. The backend uses the ignored `vp-backend-events-private.pem`, mounted by `temporary_workflow_management/docker-compose.dev.yml`. The existing `npm start` command keeps the SQS behavior. Use only one delivery transport for a backend instance; do not send the same event to HTTP and SQS.

## Generated JavaScript sandbox (development, opt-in)

`compose.generated.yaml` defines a credential-holding HTTP worker and a separate, read-only sandbox container with no JWT keys. For generated-JS execution snapshots, the worker reads the immutable `programSource`, creates `/tmp/vp-programs/<workflowExecutionId>.js` with mode `0600`, and rejects a different source for the same execution. The file contains handlers keyed by activity ID and event. The worker sends that artifact to the sandbox and brokers its OpenAPI calls back to the backend. Existing declarative snapshots continue through the old interpreter, so active executions remain compatible during rollout. The sandbox's network is internal; arbitrary external API calls are intentionally not available yet. Backend authorization checks the event plan and stores ordered operation receipts so retries do not repeat successful actions.

Do not switch the backend to `VP_PROGRAM_MODE=generated-js` until the matching framework version and the `operationReceipts` database migration are installed. In the first generated-JS stage, backend operation inputs must match constant values from the saved blocks; dynamic request bodies are not yet supported. The existing `compose.http-demo.yaml` remains the logging-only mode.

## Required configuration

- `AWS_REGION`
- `VP_QUEUE_URL` (SQS Standard queue)
- `VP_DLQ_URL` (SQS Standard dead-letter queue)
- `VP_BACKEND_BASE_URL`
- `VP_JWT_KEY_ID`
- `VP_JWT_PRIVATE_KEY_FILE` (recommended) or `VP_JWT_PRIVATE_KEY`

Optional configuration:

- `VP_JWT_ISSUER` (default `vp-runner`)
- `VP_JWT_SUBJECT` (default `vp-runner-production`)
- `VP_JWT_AUDIENCE` (default `workflow-backend`)
- `VP_REQUEST_TIMEOUT_MS` (default `10000`)
- `VP_VISIBILITY_TIMEOUT_SECONDS` (default `60`)
- `VP_MAX_ATTEMPTS` (default `5`)
- `VP_HEALTH_PORT` (default `9100`)

The private key should be mounted from a secret manager as a read-only file. Do not place it in the image, repository, SQS message, or execution plan.

The worker uses application-level idempotency through `eventId` and the persisted operation index. Standard SQS may redeliver messages or deliver different events out of order; the backend status machine and row locks prevent completed operations from being applied twice.

## Runtime security

Run the container with a read-only root filesystem, a bounded tmpfs, all Linux capabilities dropped, `no-new-privileges`, CPU/memory/PID limits, and no database environment variables. Allow outbound traffic only to SQS, the configured backend origin, DNS, and the cloud identity/secret endpoints required by the deployment.

In SQS mode, only the health endpoint is exposed. In HTTP demo mode, the authenticated `POST /vp/events` endpoint is also exposed.

## Local startup

The checked-in `.env.example` is safe to copy, but `.env` and all PEM files are ignored by Git. For this AWS account the local queue URLs are:

```text
VP_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/583909165557/vp-execution-sqs
VP_DLQ_URL=https://sqs.eu-west-1.amazonaws.com/583909165557/vp-execution-sqs-dlq
```

Create the `vp-development` AWS profile with credentials that have access only to these queues. Then start directly:

```bash
npm start
```

or, while the backend is listening on local port 5000, start the hardened local container:

```bash
docker compose up --build
curl http://localhost:9100/health
```

The compose file mounts `~/.aws` and the private key read-only. In production, do not mount a local AWS profile: assign an IAM role to the VM and mount the private key from the chosen secret manager.

The AWS redrive policy on `vp-execution-sqs` should target `vp-execution-sqs-dlq` with `maxReceiveCount=5`. The worker also moves terminal failures explicitly so the backend can persist the `DEAD_LETTER` event status immediately.
