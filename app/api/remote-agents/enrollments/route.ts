import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import {
  listApprovedAgentEnrollments,
  listPendingAgentEnrollments,
} from '@/src/lib/remote-agents/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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

  const pending = listPendingAgentEnrollments();
  const approved = listApprovedAgentEnrollments();
  return withRenewCookie(
    jsonResponse({ pending, approved, pendingCount: pending.length, approvedCount: approved.length }, 200),
    auth,
  );
}
