import { z } from 'zod';
import { remoteWorkerRepo } from '@/src/lib/db';
import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import { authenticateAgentRequest } from '@/src/lib/remote-agents/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const registerSchema = z
  .object({
    workerId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
    baseUrl: z.string().url().max(1024),
    capabilities: z.record(z.string(), z.unknown()).default({}),
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

export async function GET(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  const denied = authGuard(auth);
  if (denied) return denied;

  const workers = remoteWorkerRepo().listActive();
  return withRenewCookie(jsonResponse({ workers, count: workers.length }, 200), auth);
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

  const parsed = registerSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_body', details: parsed.error.issues }, 400);
  }

  const worker = remoteWorkerRepo().upsertHeartbeat(parsed.data);
  return jsonResponse({ worker, leaseTtlSeconds: 300 }, 200);
}
