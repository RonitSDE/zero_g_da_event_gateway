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
DA_WRITER_MODE=grpc
DA_WRITER_GRPC_ENDPOINT=127.0.0.1:51001
DA_WRITER_GRPC_PROTO_PATH=/app/protos/disperser.proto
DA_WRITER_GRPC_SERVICE=disperser.Disperser
DA_WRITER_GRPC_METHOD=DisperseBlob
DA_WRITER_GRPC_PAYLOAD_FIELD=data
# Optional extra request fields as JSON string, example:
# DA_WRITER_GRPC_EXTRA_JSON={"security_params":[{"quorum_id":0,"adversary_threshold":33,"quorum_threshold":66}]}
```

If you prefer HTTP forwarding instead of direct gRPC:

```env
DA_TARGET_MODE=local
DA_WRITER_MODE=http
DA_WRITER_UPSTREAM_URL=https://<your-da-writer-endpoint>/v1/submit
DA_WRITER_UPSTREAM_API_KEY=<optional>
```

### Notes for 0G DA

- `DA_WRITER_MODE=grpc` now performs a real gRPC call using your configured proto/service/method.
- You must provide the correct proto and method signature from your DA client setup.
- If the request schema differs, set `DA_WRITER_GRPC_PAYLOAD_FIELD` and `DA_WRITER_GRPC_EXTRA_JSON` accordingly.

