import crypto from 'node:crypto';
import { settingRepo } from '@/src/lib/db';

const TOKEN_HASH_KEY = 'remote_agent_bearer_sha256';
const TOKEN_ISSUED_AT_KEY = 'remote_agent_bearer_issued_at';

export interface AgentAuthResult {
  ok: boolean;
  error?: 'unauthorized' | 'token_not_configured';
}

export function generateAgentBearerToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function rotateAgentBearerToken(): { token: string; issuedAtIso: string } {
  const token = generateAgentBearerToken();
  const hash = sha256Hex(token);
  const issuedAtIso = new Date().toISOString();

  settingRepo().set(TOKEN_HASH_KEY, hash);
  settingRepo().set(TOKEN_ISSUED_AT_KEY, issuedAtIso);

  return { token, issuedAtIso };
}

export function getAgentTokenMeta(): { configured: boolean; issuedAtIso: string | null } {
  const hash = settingRepo().get(TOKEN_HASH_KEY);
  const issuedAtIso = settingRepo().get(TOKEN_ISSUED_AT_KEY) ?? null;
  return { configured: !!hash, issuedAtIso };
}

export function authenticateAgentRequest(req: Request): AgentAuthResult {
  const provided = getBearerOrHeaderToken(req);
  if (!provided) {
    return { ok: false, error: 'unauthorized' };
  }

  const expectedHash = settingRepo().get(TOKEN_HASH_KEY);
  if (!expectedHash) {
    return { ok: false, error: 'token_not_configured' };
  }

  const providedHash = sha256Hex(provided);
  const ok = safeEqualHex(providedHash, expectedHash);
  return ok ? { ok: true } : { ok: false, error: 'unauthorized' };
}

function getBearerOrHeaderToken(req: Request): string | null {
  const authHeader = req.headers.get('authorization');
  if (authHeader) {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m?.[1]) return m[1].trim();
  }

  const alt = req.headers.get('x-butler-agent-key');
  return alt?.trim() || null;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEqualHex(aHex: string, bHex: string): boolean {
  if (aHex.length !== bHex.length) return false;
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
