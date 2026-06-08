import crypto from 'node:crypto';
import { z } from 'zod';
import { fileRepo, jobRepo, remoteJobLeaseRepo, remoteWorkerRepo, settingRepo } from '@/src/lib/db';
import type { FileStatus } from '@/src/lib/db/schema';
import { authenticateAgentRequest } from '@/src/lib/remote-agents/auth';
import { newLeaseExpiry } from '@/src/lib/db/repos/remote-job-lease';
import { isOutputContainerSetting, resolveContainerFromSource, type OutputContainer } from '@/src/lib/encode/output-container';
import { isOutputMode, type OutputMode } from '@/src/lib/encode/output-mode';
import { outputPathFor, replaceOutputPathFor, sanitizeOutputSuffix } from '@/src/lib/encode/staging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const claimSchema = z
  .object({
    workerId: z.string().min(1).max(128),
  })
  .strict();

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function bestEffortSetFileStatus(fileId: number, status: FileStatus): void {
  const row = fileRepo().getById(fileId);
  if (!row) return;
  fileRepo().setStatus(fileId, status, row.version);
}

type OutputContract = {
  outputPath: string;
  outputContainer: OutputContainer;
  outputMode: OutputMode;
  outputSuffix: string;
};

function resolveOutputContract(file: { path: string; container_override?: string | null }, job: { force_container?: string | null }, settings: Record<string, string | undefined>): OutputContract {
  const configuredMode = settings.output_mode;
  const outputMode: OutputMode = isOutputMode(configuredMode) ? configuredMode : 'suffix';

  const configuredContainer = job.force_container ?? file.container_override ?? settings.output_container ?? 'mkv';
  const containerSetting = isOutputContainerSetting(configuredContainer) ? configuredContainer : 'mkv';
  const outputContainer: OutputContainer =
    containerSetting === 'match-source' ? resolveContainerFromSource(file.path) : containerSetting;

  const outputSuffix = sanitizeOutputSuffix(settings.output_suffix, outputContainer);
  const outputPathLocal = outputMode === 'replace'
    ? replaceOutputPathFor(file.path, outputContainer)
    : outputPathFor(file.path, outputSuffix);
  const outputPath = outputPathLocal.replace(/\\/g, '/');

  return { outputPath, outputContainer, outputMode, outputSuffix };
}

function buildFfmpegArgs(encoder: string, crf: number | null, preset: string | null): string[] {
  const normalized = encoder.trim().toLowerCase();
  const args = ['-y', '-hide_banner', '-i', '{input}', '-map', '0'];

  if (normalized === 'hevc_nvenc' || normalized === 'nvenc') {
    args.push('-c:v', 'hevc_nvenc');
    args.push('-preset', preset ?? 'p5');
    args.push('-cq', String(crf ?? 28));
  } else if (normalized === 'hevc_qsv' || normalized === 'qsv') {
    args.push('-c:v', 'hevc_qsv');
    args.push('-global_quality', String(crf ?? 26));
  } else if (normalized === 'hevc_vaapi' || normalized === 'vaapi') {
    args.push('-c:v', 'hevc_vaapi');
    args.push('-qp', String(crf ?? 26));
  } else {
    args.push('-c:v', 'libx265');
    args.push('-preset', preset ?? 'medium');
    args.push('-crf', String(crf ?? 24));
  }

  args.push('-c:a', 'copy', '-c:s', 'copy', '{output}');
  return args;
}

function workerEncoderSet(activeWorker: { capabilities?: Record<string, unknown> }): Set<string> {
  const raw = activeWorker.capabilities?.encoders;
  if (!Array.isArray(raw)) return new Set();

  return new Set(
    raw
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0),
  );
}

function resolveDispatchEncoder(requested: string | null | undefined, activeWorker: { capabilities?: Record<string, unknown> }): string {
  const requestedNormalized = (requested ?? 'auto').trim().toLowerCase();
  const available = workerEncoderSet(activeWorker);

  const hasNvenc = available.has('hevc_nvenc') || available.has('nvenc');
  if (requestedNormalized === 'auto') {
    return hasNvenc ? 'hevc_nvenc' : 'libx265';
  }

  if ((requestedNormalized === 'hevc_nvenc' || requestedNormalized === 'nvenc') && !hasNvenc) {
    return 'libx265';
  }

  return requestedNormalized;
}

function reconcileExpiredLeases(): void {
  const expired = remoteJobLeaseRepo().listExpiredActive();
  for (const lease of expired) {
    const job = jobRepo().findById(lease.job_id);
    if (!job) {
      remoteJobLeaseRepo().setState(lease.job_id, 'cancelled', {
        message: 'lease_expired_job_missing',
        leaseExpiresAt: newLeaseExpiry(),
      });
      continue;
    }

    const shouldRequeue = lease.state === 'claimed' && (lease.progress_percent ?? 0) <= 0;
    if (shouldRequeue) {
      const requeued = jobRepo().requeueFromEncoding(job.id, 'remote_lease_expired_requeued');
      if (requeued) {
        bestEffortSetFileStatus(job.file_id, 'queued');
        remoteJobLeaseRepo().setState(job.id, 'cancelled', {
          message: 'lease_expired_requeued',
          leaseExpiresAt: newLeaseExpiry(),
        });
        continue;
      }
    }

    const interrupted = jobRepo().markInterrupted(job.id, 'remote_lease_expired');
    if (interrupted) {
      bestEffortSetFileStatus(job.file_id, 'interrupted');
    }
    remoteJobLeaseRepo().setState(job.id, 'cancelled', {
      message: 'lease_expired_interrupted',
      leaseExpiresAt: newLeaseExpiry(),
    });
  }
}

export async function POST(req: Request): Promise<Response> {
  const agentAuth = authenticateAgentRequest(req);
  if (!agentAuth.ok) {
    const status = agentAuth.error === 'token_not_configured' ? 503 : 401;
    return jsonResponse({ error: agentAuth.error }, status);
  }

  const contentType = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return jsonResponse({ error: 'unsupported_media_type' }, 415);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const parsed = claimSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_body', details: parsed.error.issues }, 400);
  }

  const activeWorker = remoteWorkerRepo().getActiveByWorkerId(parsed.data.workerId);
  if (!activeWorker) {
    return jsonResponse({ error: 'worker_not_registered' }, 409);
  }

  reconcileExpiredLeases();

  const job = jobRepo().claimNext();
  if (!job) {
    return jsonResponse({ job: null }, 200);
  }

  const file = fileRepo().getById(job.file_id);
  if (!file) {
    jobRepo().markCancelled(job.id);
    return jsonResponse({ error: 'file_not_found_for_job', jobId: job.id }, 409);
  }

  const leaseToken = crypto.randomBytes(32).toString('base64url');
  const leaseExpiresAt = newLeaseExpiry();
  const lease = remoteJobLeaseRepo().put({
    jobId: job.id,
    workerId: parsed.data.workerId,
    leaseToken,
    state: 'claimed',
    leaseExpiresAt,
  });

  bestEffortSetFileStatus(file.id, 'encoding');

  const settings = {
    cache_pool_path: settingRepo().get('cache_pool_path'),
    output_suffix: settingRepo().get('output_suffix'),
    output_container: settingRepo().get('output_container'),
    output_mode: settingRepo().get('output_mode'),
  };
  const cacheRoot = settings.cache_pool_path || '/cache';
  const output = resolveOutputContract(file, job, settings);
  const preset = (job.preset_used ?? null) as string | null;
  const crf = job.crf ?? null;
  const encoder = resolveDispatchEncoder(job.encoder, activeWorker);
  const ffmpegArgs = buildFfmpegArgs(encoder, crf, preset);

  return jsonResponse(
    {
      job: {
        id: job.id,
        fileId: job.file_id,
        sourcePath: file.path,
        encoder,
        crf,
        preset,
        cacheRoot,
        outputPath: output.outputPath,
        outputContainer: output.outputContainer,
        outputMode: output.outputMode,
        outputSuffix: output.outputSuffix,
        ffmpegArgs,
      },
      lease: {
        workerId: lease.worker_id,
        leaseToken,
        state: lease.state,
        leaseExpiresAtIso: new Date(lease.lease_expires_at * 1000).toISOString(),
      },
    },
    200,
  );
}
