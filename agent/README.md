# x265-butler-agent

Windows-first remote worker scaffold for x265-butler.

Current scope:

- HTTP health endpoint
- ffmpeg encoder capability probe
- GPU adapter discovery for Windows-first workers
- SMB-backed path mapping from Butler container paths to local worker paths
- job preflight validation for source readability and cache/work writability
- API key authentication for Butler-to-agent calls
- Butler pull-dispatch loop for `claim` -> `start` -> `progress` -> `complete`
- Butler dispatch background loop (`claim` -> `start` -> `progress` -> `complete`)
- Claim contract consumption for `outputPath`, `outputContainer`, `outputMode`, `crf`, `preset`, and `ffmpegArgs` templates
- Lease heartbeat refresh during long-running ffmpeg jobs
- Windows service install script
- Windows MSI build script

Current endpoints:

- `GET /health`
- `GET /v1/capabilities`
- `POST /v1/path-maps/resolve`
- `POST /v1/jobs/validate`
- `GET /v1/jobs`
- `GET /v1/jobs/{id}`
- `POST /v1/jobs/prepare`
- `POST /v1/jobs/{id}/claim`
- `POST /v1/jobs/{id}/start`
- `POST /v1/jobs/{id}/progress`
- `POST /v1/jobs/{id}/complete`

Local run:

```powershell
Set-Location C:\source\x265-butler\agent
dotnet run --project .\src\X265Butler.Agent.Worker\X265Butler.Agent.Worker.csproj
```

This is not yet a full remote execution implementation. It is the first slice needed before Butler can claim jobs remotely and dispatch ffmpeg to a Windows GPU worker.

Windows service install:

```powershell
Set-Location C:\source\x265-butler\agent
& .\scripts\install-windows-service.ps1 -WhatIf
```

Build MSI installer:

```powershell
Set-Location C:\source\x265-butler\agent
& .\scripts\build-msi.ps1 -WhatIf
& .\scripts\build-msi.ps1 -ProductVersion 1.0.0 -BundleFfmpeg
& .\scripts\build-msi.ps1 -ProductVersion 1.0.0 -BundleFfmpeg -EnrollmentUrl 'http://unraid2:3008' -EnrollmentToken '<one-time-token>'
```

Optional service account defaults at build time:

```powershell
Set-Location C:\source\x265-butler\agent
& .\scripts\build-msi.ps1 -ProductVersion 1.0.0 -ServiceAccount 'DOMAIN\\svc-x265' -ServicePassword 'change-me'
```

Optional service account overrides at install time (recommended for SMB/UNC access):

```powershell
msiexec /i "C:\source\x265-butler\agent\artifacts\msi\x265-butler-agent-1.0.0-win-x64.msi" AGENT_SERVICE_ACCOUNT="DOMAIN\\svc-x265" AGENT_SERVICE_PASSWORD="<password>"
```

Important:

- To switch away from `LocalSystem`, provide both `AGENT_SERVICE_ACCOUNT` and `AGENT_SERVICE_PASSWORD` on install.
- If either is omitted, installer keeps the default LocalSystem behavior.

MSI output path:

- `C:\source\x265-butler\agent\artifacts\msi\x265-butler-agent-<version>-win-x64.msi`

Notes:

- MSI install root is `C:\Program Files\x265-butler-agent`.
- Service is created as `x265-butler-agent` and starts automatically.
- MSI defaults service logon to `LocalSystem` unless `AGENT_SERVICE_ACCOUNT`/`AGENT_SERVICE_PASSWORD` are supplied.
- WiX CLI is pinned via local tool manifest: `C:\source\x265-butler\agent\dotnet-tools.json`.
- With `-BundleFfmpeg`, installer payload includes ffmpeg binaries and config points to bundled `ffmpeg\\ffmpeg.exe`.
- If ffmpeg is not on PATH, pass `-FfmpegSourcePath "C:\path\to\ffmpeg\bin"`.

Butler dispatch config (`appsettings.json`, section `Butler`):

- `Enabled`: enables active polling/dispatch to Butler.
- `BaseUrl`: Butler base URL.
- `BearerToken`: token from `POST /api/remote-agents/token`.
- `EnrollmentToken`: one-time bootstrap token from `POST /api/remote-agents/enroll-token`.
- `PollIntervalSeconds`: idle wait between claim attempts.
- `RegisterIntervalSeconds`: worker heartbeat/register interval.
- `AllowValidationOnlySuccess`: when true, worker can complete jobs after path/ffmpeg validation only (smoke mode).

Bootstrap enrollment flow:

- `POST /api/remote-agents/enroll-token` (operator-auth protected) mints a short-lived one-time enrollment token.
- MSI/appsettings provides `Butler.BaseUrl` + `Butler.EnrollmentToken`.
- Agent first-start calls `POST /api/remote-agents/enroll` and enters pending approval.
- Operator approves the worker in Butler Settings -> Remote Agent Approvals.
- After approval, `POST /api/remote-agents/enroll` returns a normal bearer token.
- Agent persists the bearer token and clears `EnrollmentToken`.

Important:

- Default `AllowValidationOnlySuccess=false`: worker runs real ffmpeg and reports real bytes/duration.
- Set `AllowValidationOnlySuccess=true` only for smoke tests when you want jobs to pass after validation even if ffmpeg fails on the worker host.
- Worker resolves Butler-provided remote output paths via SMB path mappings and validates output artifact size before reporting success.
