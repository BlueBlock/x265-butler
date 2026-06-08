import { z } from 'zod';
import {
  authenticateAgentEnrollmentToken,
  isAgentEnrollmentApproved,
  rotateAgentBearerToken,
  upsertPendingAgentEnrollment,
} from '@/src/lib/remote-agents/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const enrollSchema = z
  .object({
    enrollmentToken: z.string().min(1),
    workerId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
    machineName: z.string().max(256).optional(),
    platform: z.string().max(256).optional(),
    capabilities: z.record(z.string(), z.unknown()).optional(),
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

export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'invalid_json' }, 400);
  }

  const parsed = enrollSchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: 'invalid_body', details: parsed.error.issues }, 400);
  }

  const auth = authenticateAgentEnrollmentToken(parsed.data.enrollmentToken.trim());
  if (!auth.ok) {
    if (auth.error === 'expired') {
      return jsonResponse({ error: 'enrollment_token_expired' }, 401);
    }

    return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const workerId = parsed.data.workerId.trim();
  if (!isAgentEnrollmentApproved(workerId)) {
    const pending = upsertPendingAgentEnrollment({
      workerId,
      displayName: parsed.data.displayName,
      machineName: parsed.data.machineName,
      platform: parsed.data.platform,
      capabilities: parsed.data.capabilities ?? {},
    });

    return jsonResponse(
      {
        approved: false,
        status: 'pending_approval',
        workerId,
        requestedAtIso: pending.requestedAtIso,
        lastSeenAtIso: pending.lastSeenAtIso,
      },
      202,
    );
  }

  const rotated = rotateAgentBearerToken();
  return jsonResponse(
    { approved: true, token: rotated.token, issuedAtIso: rotated.issuedAtIso },
    201,
  );
}
