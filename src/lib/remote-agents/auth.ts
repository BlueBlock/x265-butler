import crypto from 'node:crypto';
import { settingRepo } from '@/src/lib/db';

const TOKEN_HASH_KEY = 'remote_agent_bearer_sha256';
const TOKEN_ISSUED_AT_KEY = 'remote_agent_bearer_issued_at';
const ENROLL_TOKEN_HASH_KEY = 'remote_agent_enroll_token_sha256';
const ENROLL_TOKEN_ISSUED_AT_KEY = 'remote_agent_enroll_token_issued_at';
const ENROLL_TOKEN_EXPIRES_AT_KEY = 'remote_agent_enroll_token_expires_at';
const ENROLL_PENDING_KEY = 'remote_agent_enroll_pending_json';
const ENROLL_APPROVED_KEY = 'remote_agent_enroll_approved_json';

export interface AgentAuthResult {
  ok: boolean;
  error?: 'unauthorized' | 'token_not_configured';
}

export interface PendingAgentEnrollment {
  workerId: string;
  displayName: string;
  machineName: string | null;
  platform: string | null;
  capabilities: Record<string, unknown>;
  requestedAtIso: string;
  lastSeenAtIso: string;
}

export interface ApprovedAgentEnrollment {
  workerId: string;
  approvedAtIso: string;
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

export function rotateAgentEnrollmentToken(ttlMinutes = 30): {
  token: string;
  issuedAtIso: string;
  expiresAtIso: string;
} {
  const token = generateAgentBearerToken();
  const hash = sha256Hex(token);
  const issuedAtIso = new Date().toISOString();
  const expiresAtIso = new Date(Date.now() + Math.max(1, ttlMinutes) * 60_000).toISOString();

  settingRepo().set(ENROLL_TOKEN_HASH_KEY, hash);
  settingRepo().set(ENROLL_TOKEN_ISSUED_AT_KEY, issuedAtIso);
  settingRepo().set(ENROLL_TOKEN_EXPIRES_AT_KEY, expiresAtIso);

  return { token, issuedAtIso, expiresAtIso };
}

export function getAgentEnrollmentTokenMeta(): {
  configured: boolean;
  issuedAtIso: string | null;
  expiresAtIso: string | null;
} {
  const hash = settingRepo().get(ENROLL_TOKEN_HASH_KEY);
  const issuedAtIso = settingRepo().get(ENROLL_TOKEN_ISSUED_AT_KEY) ?? null;
  const expiresAtIso = settingRepo().get(ENROLL_TOKEN_EXPIRES_AT_KEY) ?? null;
  return { configured: !!hash, issuedAtIso, expiresAtIso };
}

export function authenticateAgentEnrollmentToken(token: string):
  | { ok: true }
  | { ok: false; error: 'not_configured' | 'expired' | 'unauthorized' } {
  const expectedHash = settingRepo().get(ENROLL_TOKEN_HASH_KEY);
  if (!expectedHash) {
    return { ok: false, error: 'not_configured' };
  }

  const expiresAtIso = settingRepo().get(ENROLL_TOKEN_EXPIRES_AT_KEY);
  if (expiresAtIso && Date.parse(expiresAtIso) <= Date.now()) {
    clearAgentEnrollmentToken();
    return { ok: false, error: 'expired' };
  }

  const providedHash = sha256Hex(token);
  const ok = safeEqualHex(providedHash, expectedHash);
  return ok ? { ok: true } : { ok: false, error: 'unauthorized' };
}

export function consumeAgentEnrollmentToken(token: string):
  | { ok: true }
  | { ok: false; error: 'not_configured' | 'expired' | 'unauthorized' } {
  const auth = authenticateAgentEnrollmentToken(token);
  if (!auth.ok) return auth;

  clearAgentEnrollmentToken();
  return { ok: true };
}

export function listPendingAgentEnrollments(): PendingAgentEnrollment[] {
  const pending = readJson<PendingAgentEnrollment[]>(ENROLL_PENDING_KEY, []);
  return pending
    .filter((entry) => !!entry.workerId)
    .sort((a, b) => b.lastSeenAtIso.localeCompare(a.lastSeenAtIso));
}

export function listApprovedAgentEnrollments(): ApprovedAgentEnrollment[] {
  const approved = readJson<ApprovedAgentEnrollment[]>(ENROLL_APPROVED_KEY, []);
  return approved
    .filter((entry) => !!entry.workerId)
    .sort((a, b) => b.approvedAtIso.localeCompare(a.approvedAtIso));
}

export function isAgentEnrollmentApproved(workerId: string): boolean {
  if (!workerId.trim()) return false;
  return listApprovedAgentEnrollments().some((entry) => entry.workerId === workerId);
}

export function upsertPendingAgentEnrollment(input: {
  workerId: string;
  displayName: string;
  machineName?: string | null;
  platform?: string | null;
  capabilities?: Record<string, unknown>;
}): PendingAgentEnrollment {
  const workerId = input.workerId.trim();
  const nowIso = new Date().toISOString();
  const pending = listPendingAgentEnrollments();
  const existing = pending.find((entry) => entry.workerId === workerId);

  const next: PendingAgentEnrollment = {
    workerId,
    displayName: input.displayName.trim() || workerId,
    machineName: input.machineName?.trim() || null,
    platform: input.platform?.trim() || null,
    capabilities: input.capabilities ?? {},
    requestedAtIso: existing?.requestedAtIso ?? nowIso,
    lastSeenAtIso: nowIso,
  };

  const merged = pending.filter((entry) => entry.workerId !== workerId);
  merged.push(next);
  writeJson(ENROLL_PENDING_KEY, merged);
  return next;
}

export function approvePendingAgentEnrollment(workerId: string): {
  approved: ApprovedAgentEnrollment;
  pending: PendingAgentEnrollment | null;
} {
  const normalized = workerId.trim();
  const pending = listPendingAgentEnrollments();
  const entry = pending.find((item) => item.workerId === normalized) ?? null;

  const approved = listApprovedAgentEnrollments().filter((item) => item.workerId !== normalized);
  const approvedEntry: ApprovedAgentEnrollment = {
    workerId: normalized,
    approvedAtIso: new Date().toISOString(),
  };
  approved.push(approvedEntry);
  writeJson(ENROLL_APPROVED_KEY, approved);

  const remainingPending = pending.filter((item) => item.workerId !== normalized);
  writeJson(ENROLL_PENDING_KEY, remainingPending);

  return { approved: approvedEntry, pending: entry };
}

export function rejectPendingAgentEnrollment(workerId: string): { removed: boolean } {
  const normalized = workerId.trim();
  const pending = listPendingAgentEnrollments();
  const remainingPending = pending.filter((item) => item.workerId !== normalized);
  writeJson(ENROLL_PENDING_KEY, remainingPending);

  const approved = listApprovedAgentEnrollments();
  const remainingApproved = approved.filter((item) => item.workerId !== normalized);
  writeJson(ENROLL_APPROVED_KEY, remainingApproved);

  return { removed: remainingPending.length !== pending.length };
}

function clearAgentEnrollmentToken(): void {
  settingRepo().set(ENROLL_TOKEN_HASH_KEY, '');
  settingRepo().set(ENROLL_TOKEN_ISSUED_AT_KEY, '');
  settingRepo().set(ENROLL_TOKEN_EXPIRES_AT_KEY, '');
}

function readJson<T>(key: string, fallback: T): T {
  const raw = settingRepo().get(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  settingRepo().set(key, JSON.stringify(value));
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
