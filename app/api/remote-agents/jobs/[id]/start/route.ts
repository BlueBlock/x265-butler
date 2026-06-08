import { z } from 'zod';
import { fileRepo, jobRepo, remoteJobLeaseRepo } from '@/src/lib/db';
import { authenticateAgentRequest } from '@/src/lib/remote-agents/auth';
import { newLeaseExpiry } from '@/src/lib/db/repos/remote-job-lease';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const bodySchema = z
  .object({
    workerId: z.string().min(1).max(128),
    leaseToken: z.string().min(8),
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

  const updatedLease = remoteJobLeaseRepo().setState(jobId, 'running', {
    leaseExpiresAt: newLeaseExpiry(),
  });

  const job = jobRepo().findById(jobId);
  if (job) {
    const file = fileRepo().getById(job.file_id);
    if (file) {
      fileRepo().setStatus(file.id, 'encoding', file.version);
    }
  }

  return jsonResponse({ lease: updatedLease }, 200);
}
