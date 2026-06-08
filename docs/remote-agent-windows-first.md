# Remote Agent: Windows First

This document defines the first implementation slice for remote GPU execution.

## Goal

Keep x265-butler as the control plane while a remote Windows worker performs ffmpeg execution against shared SMB storage.

## v1 Assumptions

- Butler remains the only queue and policy owner.
- Shared storage is already exposed to the worker over SMB.
- The worker reads and writes directly against shared storage.
- No file transfer pipeline is added in v1.
- Windows is the first worker target.

## Why a .NET Agent

- Strong fit for a Windows service target.
- One codebase can later support Linux/Proxmox workers.
- Reliable process orchestration around ffmpeg and GPU probes.
- Typed contracts for capability, path resolution, and job validation.

## Control Plane Split

### Butler server

- Scans media
- Owns queue state
- Chooses worker
- Issues job claims
- Receives progress and completion

### Agent worker

- Reports local capabilities
- Resolves Butler paths like `/library` and `/cache` to local SMB paths
- Validates source and work-root access
- Executes ffmpeg locally on the Windows GPU box

## v1 HTTP Surface

### `GET /health`

Basic liveness.

### `GET /v1/capabilities`

Reports:

- agent id
- machine/platform
- ffmpeg path/version
- encoder availability
- GPU adapters
- configured path mappings

### `POST /v1/path-maps/resolve`

Translates a Butler path to the local worker-visible path.

### `POST /v1/jobs/validate`

Checks source existence and cache/work-root writability before real dispatch exists.

## Example path mapping

- `/library/Movie.mkv` -> `\\unraid2\entertainment\entertainmentfiles\New Movies\Movie.mkv`
- `/cache/work/17` -> `\\unraid2\cache\x265-butler\work\17`

## Next steps

1. Replace in-memory worker registry and in-memory job state with durable leases and recovery.
2. Add ffmpeg execution and stderr progress parsing in the agent.
3. Add completion callback signing and retry policy.
4. Add Linux worker support for Proxmox after Windows is stable.

## Butler-side endpoints (implemented)

### `GET /api/remote-agents/token`

Operator-auth protected. Returns whether an agent bearer token is configured.

```json
{
  "configured": true,
  "issuedAtIso": "2026-06-08T12:00:00.000Z"
}
```

### `POST /api/remote-agents/token`

Operator-auth protected. Rotates the bearer token and returns it once.

```json
{
  "token": "<new token>",
  "issuedAtIso": "2026-06-08T12:00:00.000Z"
}
```

### `GET /api/remote-agents/workers`

Operator-auth protected. Lists currently registered/active workers from SQLite
(`remote_worker` table, 5-minute lease timeout).

### `POST /api/remote-agents/workers`

Agent-auth protected (`Authorization: Bearer <token>` or `X-Butler-Agent-Key`).
Upserts worker registration/heartbeat into SQLite (`remote_worker`).

### Durable lease state

Migration `0029_remote_agents.sql` adds:

- `remote_worker`: persistent worker heartbeats + lease expiry.
- `remote_job_lease`: persistent per-job remote lease/lifecycle state (foundation for claim/start/progress/complete durability).

## Butler-side job lease endpoints (implemented)

### `POST /api/remote-agents/jobs/claim`

Agent-auth protected. Worker pulls the next queued job, creates/refreshes a
`remote_job_lease` row in `claimed` state, and receives a short-lived lease token.

Request:

```json
{
  "workerId": "windows-gpu-01"
}
```

Response (when work is available):

```json
{
  "job": {
    "id": 42,
    "fileId": 77,
    "sourcePath": "/library/movie.mkv",
    "encoder": "nvenc",
    "cacheRoot": "/cache",
    "outputPath": "/library/movie-x265.mkv",
    "outputContainer": "mkv",
    "outputMode": "suffix",
    "outputSuffix": "-x265.mkv",
    "crf": 24,
    "preset": "medium",
    "ffmpegArgs": ["-y", "-hide_banner", "-i", "{input}", "-map", "0", "-c:v", "libx265", "-preset", "medium", "-crf", "24", "-c:a", "copy", "-c:s", "copy", "{output}"]
  },
  "lease": {
    "workerId": "windows-gpu-01",
    "leaseToken": "<opaque>",
    "state": "claimed",
    "leaseExpiresAtIso": "2026-06-08T12:00:00.000Z"
  }
}
```

Response (no work):

```json
{
  "job": null
}
```

### `POST /api/remote-agents/jobs/{id}/start`

Agent-auth protected. Validates active lease token and transitions lease to
`running` (extends lease TTL).

### `POST /api/remote-agents/jobs/{id}/progress`

Agent-auth protected. Validates active lease token and updates
`progress_percent`/`message` while keeping `running` state.

Progress updates also act as lease-heartbeats (`lease_expires_at` extension).

### `POST /api/remote-agents/jobs/{id}/complete`

Agent-auth protected. Validates active lease token, marks the core `job` row as
`done` or `failed`, updates file status best-effort, and transitions
`remote_job_lease` to `completed`/`failed`.

Success payloads require `bytesOut > 0` to prevent false-positive completes.

### Expired-lease reconciliation

Claim flow now reconciles expired active leases before issuing a new claim:

- `claimed` lease with no progress: deterministic requeue (`job` back to `queued`).
- `running` (or claimed-with-progress) lease: deterministic interrupt (`job` -> `interrupted`).

Request body:

```json
{
  "workerId": "windows-gpu-01",
  "displayName": "Windows GPU Worker 01",
  "baseUrl": "http://windows-gpu-01:4120",
  "capabilities": { "encoders": ["nvenc", "libx265"] }
}
```
