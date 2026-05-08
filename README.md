# 0G DA Event Gateway

Production event ingestion gateway for kult games.

Accepts events over HTTP, batches them via BullMQ, and submits to the **0G DA disperser over gRPC**. Every event gets a `storageRoot`, `epoch`, and `quorumId` from the DA layer — verifiable proof that the event was committed on-chain.

## Trust model

- This service is an **operator relay** (server-managed ingestion and retries), not a user-signed DA client.
- DA proof fields are only valid after status reaches `CONFIRMED`/`FINALIZED`; failed jobs do not produce retrievable proof.
- Production mode should fail closed if upstream DA prerequisites are invalid.

## Architecture

```
Game backend  →  POST /v1/events
                      ↓
              BullMQ + Valkey (batch, retry)
                      ↓
              0G DA disperser (gRPC: DisperseBlob)
                      ↓  polls GetBlobStatus
              MongoDB (storageRoot, epoch, quorumId)
```

## Event format

Single event:

```json
{
  "game": "warzoneWarriors",
  "event": "session.completed",
  "data": {
    "sessionId": "abc-123",
    "walletAddress": "0x...",
    "score": 4200
  }
}
```

Batch:

```json
{
  "events": [
    { "game": "highwayHustle", "event": "score.best", "data": { "walletAddress": "0x1", "score": 9900 } },
    { "game": "guessTheAI", "event": "round.completed", "data": { "walletAddress": "0x2", "correct": true } }
  ]
}
```

## API

All endpoints (except `/health` and `/v1/da/health`) require:

```
Authorization: Bearer <INGEST_API_KEY>
```

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Queue stats |
| `GET` | `/v1/da/health` | DA writer mode, gRPC target, auth status |
| `POST` | `/v1/events` | Ingest single or batch events |
| `POST` | `/v1/events/batch` | Explicit batch ingestion |
| `GET` | `/v1/da/status/:eventId` | Full event status |
| `GET` | `/v1/da/proof/:eventId` | DA proof (storageRoot, epoch, quorumId) |
| `POST` | `/v1/da/retrieve/:eventId` | Retrieve raw blob from DA |
| `GET` | `/v1/failed-events` | List dead-letter events |
| `POST` | `/v1/failed-events/:eventId/replay` | Replay a failed event |

### Proof response

```json
{
  "eventId": "550e8400-e29b-41d4-a716-446655440000",
  "daStatus": "CONFIRMED",
  "storageRoot": "Abc123...base64...",
  "epoch": 12,
  "quorumId": 0,
  "daReference": "grpc-da-a1b2c3d4e5f6...",
  "confirmedAt": "2026-05-03T10:22:41.000Z"
}
```

## Quick start (local testing)

```bash
cd zero_g_da_event_gateway
npm install
cp .env.example .env
# Edit .env: set MONGO_URL, REDIS_URL, INGEST_API_KEY
# For local testing only: set DA_WRITER_MODE=mock
npm run dev
```

Health check:

```bash
curl http://localhost:3300/health
```

Ingest an event:

```bash
curl -X POST http://localhost:3300/v1/events \
  -H "Authorization: Bearer <INGEST_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"game":"highwayHustle","event":"score.best","data":{"walletAddress":"0xabc","score":9900}}'
```

## Production config (0G DA via gRPC)

```env
DA_TARGET_MODE=local
DA_WRITER_MODE=grpc
DA_WRITER_GRPC_ENDPOINT=127.0.0.1:51001
DA_WRITER_GRPC_PROTO_PATH=/opt/zero_g_da_event_gateway/protos/disperser.proto
DA_WRITER_GRPC_SERVICE=disperser.Disperser
DA_WRITER_GRPC_METHOD=DisperseBlob
DA_WRITER_GRPC_PAYLOAD_FIELD=data
DA_WRITER_GRPC_EXTRA_JSON={"security_params":[{"quorum_id":0,"adversary_threshold":33,"quorum_threshold":66}]}
DA_STARTUP_STRICT=true
DA_CHAIN_RPC=https://rpc.ankr.com/0g_galileo_testnet_evm
DA_EXPECTED_CHAIN_ID=40da
DA_ENTRANCE_CONTRACT_ADDR=0x...
REQUIRE_AUTH=true
INGEST_API_KEY=<strong-secret>
```

For local testing only:

```env
DA_WRITER_MODE=mock
REQUIRE_AUTH=false
VALIDATE_EVENT_TYPES=false
```

## Live proof

Ingest a game event:

```bash
curl -X POST https://da.warzonewarriors.xyz/v1/events \
  -H "Authorization: Bearer <INGEST_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"game":"warzoneWarriors","event":"session.completed","data":{"walletAddress":"0xA94965a9dcD684101C7D2C5802ba32230E275093","score":4200}}'
# → {"success":true,"accepted":1,"queued":1}
# response includes eventId
```

Check DA status:

```bash
curl https://da.warzonewarriors.xyz/v1/da/status/<eventId> \
  -H "Authorization: Bearer <INGEST_API_KEY>"
```

Retrieve proof once CONFIRMED:

```bash
curl https://da.warzonewarriors.xyz/v1/da/proof/<eventId> \
  -H "Authorization: Bearer <INGEST_API_KEY>"
# → {"daStatus":"CONFIRMED","storageRoot":"...","epoch":12,"quorumId":0}
```

## Retry and dead-letter queue

Failed DA submissions are retried up to `MAX_RETRIES` times (default 5) with exponential backoff. Events that exhaust all retries are marked `failed_permanent` and held in the dead-letter queue.

List failed events:

```bash
curl "https://da.warzonewarriors.xyz/v1/failed-events?game=highwayHustle&limit=20" \
  -H "Authorization: Bearer <INGEST_API_KEY>"
```

Replay a specific event:

```bash
curl -X POST https://da.warzonewarriors.xyz/v1/failed-events/<eventId>/replay \
  -H "Authorization: Bearer <INGEST_API_KEY>"
```

## E2E smoke tests

```bash
BASE_URL=http://127.0.0.1:8080 INGEST_API_KEY=<INGEST_API_KEY> npm run test:e2e:da
# Optional failure assertion:
# EXPECT_RESULT=failure BASE_URL=http://127.0.0.1:8080 INGEST_API_KEY=<INGEST_API_KEY> npm run test:e2e:da
```

## Connecting from game backends

```js
// fire-and-forget from any backend service
await fetch("https://da.warzonewarriors.xyz/v1/events", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.DA_INGEST_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    game: "highwayHustle",
    event: "score.best",
    data: { walletAddress, score, gameMode }
  })
});
```
