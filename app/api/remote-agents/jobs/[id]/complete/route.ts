import { z } from 'zod';
import { fileRepo, jobRepo, remoteJobLeaseRepo } from '@/src/lib/db';
import type { FileStatus } from '@/src/lib/db/schema';
import { authenticateAgentRequest } from '@/src/lib/remote-agents/auth';
import { newLeaseExpiry } from '@/src/lib/db/repos/remote-job-lease';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    workerId: z.string().min(1).max(128),
    leaseToken: z.string().min(8),
    success: z.boolean(),
    bytesIn: z.number().int().nonnegative().optional(),
    bytesOut: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    errorMessage: z.string().max(4096).optional(),
    logTail: z.string().max(32768).nullable().optional(),
    message: z.string().max(4096).optional(),
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

export async function POST(req: Request, ctx: RouteContext): Promise<Response> {
  const agentAuth = authenticateAgentRequest(req);
  if (!agentAuth.ok) {
    const status = agentAuth.error === 'token_not_configured' ? 503 : 401;
    return jsonResponse({ error: agentAuth.error }, status);
  }

  const params = await ctx.params;
  const jobId = Number.parseInt(params.id, 10);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    return jsonResponse({ error: 'invalid_job_id' }, 400);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_body' }, 400);
  }

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_body', details: parsed.error.issues }, 400);
  }

  const lease = remoteJobLeaseRepo().validateActiveLease(
    jobId,
    parsed.data.workerId,
    parsed.data.leaseToken,
  );
  if (!lease) {
    return jsonResponse({ error: 'invalid_lease' }, 409);
  }

  const activeJob = jobRepo().findById(jobId);
  if (!activeJob) {
    return jsonResponse({ error: 'job_not_found' }, 404);
  }

  if (parsed.data.success) {
    const bytesIn = parsed.data.bytesIn ?? 0;
    const bytesOut = parsed.data.bytesOut ?? 0;
    const durationMs = parsed.data.durationMs ?? 0;

    if (bytesOut <= 0) {
      return jsonResponse({ error: 'invalid_success_payload', details: 'bytesOut must be > 0' }, 400);
    }

    const completed = jobRepo().markCompleted(jobId, {
      bytes_in: bytesIn,
      bytes_out: bytesOut,
      duration_ms: durationMs,
    });
    if (!completed) {
      return jsonResponse({ error: 'job_not_encoding' }, 409);
    }

    const outcome: FileStatus = bytesOut < bytesIn ? 'done-smaller' : 'done-larger';
    bestEffortSetFileStatus(activeJob.file_id, outcome);

    const updatedLease = remoteJobLeaseRepo().setState(jobId, 'completed', {
      progressPercent: 100,
      message: parsed.data.message,
      leaseExpiresAt: newLeaseExpiry(),
    });

    return jsonResponse({ job: completed, lease: updatedLease, outcome }, 200);
  }

  const failed = jobRepo().markFailed(jobId, {
    exit_code: parsed.data.exitCode ?? 1,
    error_msg: parsed.data.errorMessage ?? 'remote encode failed',
    log_tail: parsed.data.logTail ?? null,
  });
  if (!failed) {
    return jsonResponse({ error: 'job_not_encoding' }, 409);
  }

  bestEffortSetFileStatus(activeJob.file_id, 'failed');

  const updatedLease = remoteJobLeaseRepo().setState(jobId, 'failed', {
    message: parsed.data.message ?? parsed.data.errorMessage,
    leaseExpiresAt: newLeaseExpiry(),
  });

  return jsonResponse({ job: failed, lease: updatedLease }, 200);
}
