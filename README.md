# DA Event Gateway

Shared event ingestion service for multiple games (`guess_the_ai`, `highwayHustle`, etc).

## What it does

- Accepts events over HTTP (`/v1/events`, `/v1/events/batch`)
- Queues and batches events
- Delivers batches to a configurable target:
  - `mock` (default, local references)
  - `http` (real upstream endpoint)
  - `grpc` (placeholder; requires your exact proto wiring)
- Stores event/batch history in Mongo (optional but recommended)

## Event format

```json
{
  "game": "warzonewariors",
  "event": "session",
  "data": {
    "sessionId": "abc-123",
    "walletAddress": "0x...",
    "action": "login"
  }
}
```

Batch format:

```json
{
  "events": [
    { "game": "guess_the_ai", "event": "session.login", "data": { "walletAddress": "0x1" } },
    { "game": "highwayHustle", "event": "session.start", "data": { "sessionId": "s2" } }
  ]
}
```

## Quick start

```bash
cd da_event_gateway
npm install
cp .env.example .env
npm run dev
```

Health check:

```bash
curl http://localhost:3300/health
```

Ingest single event:

```bash
curl -X POST http://localhost:3300/v1/events \
  -H "Content-Type: application/json" \
  -d '{"game":"guess_the_ai","event":"session.login","data":{"walletAddress":"0xabc"}}'
```

## Using with your existing game backends

From any backend service:

- POST to `http://<da-gateway-host>:3300/v1/events`
- Send `{ game, event, data }`
- Keep it fire-and-forget (HTTP 202)

## Real 0G DA path

For real 0G DA delivery, set:

- `DA_TARGET_MODE=http`
- `DA_UPSTREAM_URL=<your-da-writer-endpoint>`

That upstream should be connected to your 0G DA client/encoder stack.

