import { z } from 'zod';
import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import {
  approvePendingAgentEnrollment,
  rejectPendingAgentEnrollment,
} from '@/src/lib/remote-agents/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const actionSchema = z
  .object({
    action: z.enum(['approve', 'reject']),
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

export async function POST(
  req: Request,
  context: { params: Promise<{ workerId: string }> },
): Promise<Response> {
  const auth = await requireAuth(req);
  const denied = authGuard(auth);
  if (denied) return denied;

  const workerId = decodeURIComponent((await context.params).workerId ?? '').trim();
  if (!workerId) {
    return withRenewCookie(jsonResponse({ error: 'worker_id_required' }, 400), auth);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return withRenewCookie(jsonResponse({ error: 'invalid_body' }, 400), auth);
  }

  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return withRenewCookie(jsonResponse({ error: 'invalid_body', details: parsed.error.issues }, 400), auth);
  }

  if (parsed.data.action === 'approve') {
    const result = approvePendingAgentEnrollment(workerId);
    return withRenewCookie(
      jsonResponse(
        {
          ok: true,
          action: 'approve',
          approved: result.approved,
          pending: result.pending,
        },
        200,
      ),
      auth,
    );
  }

  const result = rejectPendingAgentEnrollment(workerId);
  return withRenewCookie(jsonResponse({ ok: true, action: 'reject', removed: result.removed }, 200), auth);
}
