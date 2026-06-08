import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRequireAuth,
  mockAuthGuard,
  mockWithRenewCookie,
  mockGetAgentTokenMeta,
  mockRotateAgentBearerToken,
  mockAuthenticateAgentRequest,
  mockRemoteWorkerRepo,
} = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  mockAuthGuard: vi.fn(),
  mockWithRenewCookie: vi.fn((res: Response) => res),
  mockGetAgentTokenMeta: vi.fn(),
  mockRotateAgentBearerToken: vi.fn(),
  mockAuthenticateAgentRequest: vi.fn(),
  mockRemoteWorkerRepo: {
    listActive: vi.fn(),
    upsertHeartbeat: vi.fn(),
  },
}));

vi.mock('@/src/lib/auth/require-auth', () => ({
  requireAuth: mockRequireAuth,
  authGuard: mockAuthGuard,
  withRenewCookie: mockWithRenewCookie,
}));

vi.mock('@/src/lib/remote-agents/auth', () => ({
  getAgentTokenMeta: mockGetAgentTokenMeta,
  rotateAgentBearerToken: mockRotateAgentBearerToken,
  authenticateAgentRequest: mockAuthenticateAgentRequest,
}));

vi.mock('@/src/lib/db', () => ({
  remoteWorkerRepo: () => mockRemoteWorkerRepo,
}));

import { GET as getToken, POST as postToken } from '@/app/api/remote-agents/token/route';
import { GET as getWorkers, POST as postWorkers } from '@/app/api/remote-agents/workers/route';

beforeEach(() => {
  mockRequireAuth.mockReset();
  mockAuthGuard.mockReset();
  mockWithRenewCookie.mockReset();
  mockGetAgentTokenMeta.mockReset();
  mockRotateAgentBearerToken.mockReset();
  mockAuthenticateAgentRequest.mockReset();
  mockRemoteWorkerRepo.listActive.mockReset();
  mockRemoteWorkerRepo.upsertHeartbeat.mockReset();

  mockRequireAuth.mockResolvedValue({ ok: true, mode: 'disabled', username: null });
  mockAuthGuard.mockReturnValue(null);
  mockWithRenewCookie.mockImplementation((res: Response) => res);
});

describe('remote agent token route', () => {
  it('GET returns configured metadata', async () => {
    mockGetAgentTokenMeta.mockReturnValue({ configured: true, issuedAtIso: '2026-06-08T12:00:00Z' });
    const res = await getToken(new Request('http://test/api/remote-agents/token'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: true, issuedAtIso: '2026-06-08T12:00:00Z' });
  });

  it('POST rotates and returns token once', async () => {
    mockRotateAgentBearerToken.mockReturnValue({
      token: 'abc123',
      issuedAtIso: '2026-06-08T12:00:00Z',
    });
    const res = await postToken(new Request('http://test/api/remote-agents/token', { method: 'POST' }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ token: 'abc123', issuedAtIso: '2026-06-08T12:00:00Z' });
  });
});

describe('remote agent workers route', () => {
  it('GET returns worker list for operator-authenticated call', async () => {
    mockRemoteWorkerRepo.listActive.mockReturnValue([
      {
        workerId: 'win-01',
        displayName: 'Windows 01',
        baseUrl: 'http://win-01:4120',
        capabilities: { encoders: ['nvenc'] },
        registeredAtIso: '2026-06-08T12:00:00Z',
        lastSeenAtIso: '2026-06-08T12:01:00Z',
      },
    ]);

    const res = await getWorkers(new Request('http://test/api/remote-agents/workers'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(1);
    expect(body.workers[0].workerId).toBe('win-01');
  });

  it('POST rejects when bearer auth fails', async () => {
    mockAuthenticateAgentRequest.mockReturnValue({ ok: false, error: 'unauthorized' });
    const req = new Request('http://test/api/remote-agents/workers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'w1', displayName: 'W1', baseUrl: 'http://w1', capabilities: {} }),
    });
    const res = await postWorkers(req);
    expect(res.status).toBe(401);
  });

  it('POST upserts worker registration when bearer auth passes', async () => {
    mockAuthenticateAgentRequest.mockReturnValue({ ok: true });
    mockRemoteWorkerRepo.upsertHeartbeat.mockReturnValue({
      workerId: 'win-01',
      displayName: 'Windows 01',
      baseUrl: 'http://win-01:4120',
      capabilities: { encoders: ['nvenc'] },
      registeredAtIso: '2026-06-08T12:00:00Z',
      lastSeenAtIso: '2026-06-08T12:01:00Z',
    });

    const req = new Request('http://test/api/remote-agents/workers', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer token',
      },
      body: JSON.stringify({
        workerId: 'win-01',
        displayName: 'Windows 01',
        baseUrl: 'http://win-01:4120',
        capabilities: { encoders: ['nvenc'] },
      }),
    });

    const res = await postWorkers(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.worker.workerId).toBe('win-01');
    expect(body.leaseTtlSeconds).toBe(300);
  });
});
