# DA Event Gateway

Shared event ingestion service for multiple games (`guess_the_ai`, `highwayHustle`, etc).

## What it does

- Accepts events over HTTP (`/v1/events`, `/v1/events/batch`)
- Queues and batches events
- Delivers batches using a configurable strategy:
  - `DA_TARGET_MODE=local` (recommended single-service mode)
    - `DA_WRITER_MODE=mock` (default test mode)
    - `DA_WRITER_MODE=http` (forward to real DA writer upstream)
    - `DA_WRITER_MODE=grpc` (placeholder; requires exact proto wiring)
  - legacy direct modes still available: `mock`, `http`, `grpc`
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

## Best-practice config

Single-service (recommended for your setup):

```env
DA_TARGET_MODE=local
DA_WRITER_MODE=mock
```

When ready for real DA:

```env
DA_TARGET_MODE=local
DA_WRITER_MODE=http
DA_WRITER_UPSTREAM_URL=https://<your-da-writer-endpoint>/v1/submit
DA_WRITER_UPSTREAM_API_KEY=<optional>
```

The upstream endpoint should be connected to your 0G DA client/encoder stack.

