import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import { getAgentTokenMeta, rotateAgentBearerToken } from '@/src/lib/remote-agents/auth';

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

  const meta = getAgentTokenMeta();
  return withRenewCookie(jsonResponse(meta, 200), auth);
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  const denied = authGuard(auth);
  if (denied) return denied;

  const rotated = rotateAgentBearerToken();
  return withRenewCookie(
    jsonResponse({ token: rotated.token, issuedAtIso: rotated.issuedAtIso }, 201),
    auth,
  );
}
