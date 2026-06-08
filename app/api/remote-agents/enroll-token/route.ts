import { authGuard, requireAuth, withRenewCookie } from '@/src/lib/auth/require-auth';
import {
  getAgentEnrollmentTokenMeta,
  rotateAgentEnrollmentToken,
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

  const meta = getAgentEnrollmentTokenMeta();
  return withRenewCookie(jsonResponse(meta, 200), auth);
}

export async function POST(req: Request): Promise<Response> {
  const auth = await requireAuth(req);
  const denied = authGuard(auth);
  if (denied) return denied;

  let ttlMinutes = 30;
  try {
    const body = (await req.json()) as { ttlMinutes?: number };
    if (typeof body?.ttlMinutes === 'number' && Number.isFinite(body.ttlMinutes)) {
      ttlMinutes = Math.max(1, Math.min(24 * 60, Math.floor(body.ttlMinutes)));
    }
  } catch {
    // Empty body is valid; default TTL is used.
  }

  const rotated = rotateAgentEnrollmentToken(ttlMinutes);
  return withRenewCookie(
    jsonResponse(
      {
        token: rotated.token,
        issuedAtIso: rotated.issuedAtIso,
        expiresAtIso: rotated.expiresAtIso,
      },
      201,
    ),
    auth,
  );
}
