import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAuthenticateAgentRequest,
  mockDb,
} = vi.hoisted(() => ({
  mockAuthenticateAgentRequest: vi.fn(),
  mockDb: {
    fileRepo: {
      getById: vi.fn(),
      setStatus: vi.fn(),
    },
    jobRepo: {
      claimNext: vi.fn(),
      markCancelled: vi.fn(),
      markInterrupted: vi.fn(),
      requeueFromEncoding: vi.fn(),
      findById: vi.fn(),
      markCompleted: vi.fn(),
      markFailed: vi.fn(),
    },
    remoteJobLeaseRepo: {
      put: vi.fn(),
      listExpiredActive: vi.fn(),
      validateActiveLease: vi.fn(),
      setState: vi.fn(),
    },
    remoteWorkerRepo: {
      getActiveByWorkerId: vi.fn(),
    },
    settingRepo: {
      get: vi.fn(),
    },
  },
}));

vi.mock('@/src/lib/remote-agents/auth', () => ({
  authenticateAgentRequest: mockAuthenticateAgentRequest,
}));

vi.mock('@/src/lib/db', () => ({
  fileRepo: () => mockDb.fileRepo,
  jobRepo: () => mockDb.jobRepo,
  remoteJobLeaseRepo: () => mockDb.remoteJobLeaseRepo,
  remoteWorkerRepo: () => mockDb.remoteWorkerRepo,
  settingRepo: () => mockDb.settingRepo,
}));

vi.mock('@/src/lib/db/repos/remote-job-lease', () => ({
  newLeaseExpiry: vi.fn(() => 1_800_000_000),
}));

import { POST as claimPost } from '@/app/api/remote-agents/jobs/claim/route';
import { POST as startPost } from '@/app/api/remote-agents/jobs/[id]/start/route';
import { POST as progressPost } from '@/app/api/remote-agents/jobs/[id]/progress/route';
import { POST as completePost } from '@/app/api/remote-agents/jobs/[id]/complete/route';

beforeEach(() => {
  mockAuthenticateAgentRequest.mockReset();
  mockDb.fileRepo.getById.mockReset();
  mockDb.fileRepo.setStatus.mockReset();
  mockDb.jobRepo.claimNext.mockReset();
  mockDb.jobRepo.markCancelled.mockReset();
  mockDb.jobRepo.markInterrupted.mockReset();
  mockDb.jobRepo.requeueFromEncoding.mockReset();
  mockDb.jobRepo.findById.mockReset();
  mockDb.jobRepo.markCompleted.mockReset();
  mockDb.jobRepo.markFailed.mockReset();
  mockDb.remoteJobLeaseRepo.put.mockReset();
  mockDb.remoteJobLeaseRepo.listExpiredActive.mockReset();
  mockDb.remoteJobLeaseRepo.validateActiveLease.mockReset();
  mockDb.remoteJobLeaseRepo.setState.mockReset();
  mockDb.remoteWorkerRepo.getActiveByWorkerId.mockReset();
  mockDb.settingRepo.get.mockReset();

  mockAuthenticateAgentRequest.mockReturnValue({ ok: true });
  mockDb.remoteJobLeaseRepo.listExpiredActive.mockReturnValue([]);
  mockDb.settingRepo.get.mockImplementation((key: string) => {
    switch (key) {
      case 'cache_pool_path':
        return '/cache';
      case 'output_suffix':
        return '-x265';
      case 'output_container':
        return 'mkv';
      case 'output_mode':
        return 'suffix';
      default:
        return undefined;
    }
  });
});

describe('remote-agent jobs claim/start/progress/complete routes', () => {
  it('claim rejects unknown worker', async () => {
    mockDb.remoteWorkerRepo.getActiveByWorkerId.mockReturnValue(undefined);

    const req = new Request('http://test/api/remote-agents/jobs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'win-01' }),
    });

    const res = await claimPost(req);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'worker_not_registered' });
  });

  it('claim returns lease and job payload', async () => {
    mockDb.remoteWorkerRepo.getActiveByWorkerId.mockReturnValue({ workerId: 'win-01' });
    mockDb.jobRepo.claimNext.mockReturnValue({ id: 10, file_id: 22, encoder: 'nvenc' });
    mockDb.fileRepo.getById
      .mockReturnValueOnce({ id: 22, path: '/library/a.mkv', version: 2 })
      .mockReturnValueOnce({ id: 22, path: '/library/a.mkv', version: 2 });
    mockDb.remoteJobLeaseRepo.put.mockReturnValue({
      job_id: 10,
      worker_id: 'win-01',
      lease_token: 'token',
      state: 'claimed',
      progress_percent: null,
      message: null,
      lease_expires_at: 1_800_000_000,
      created_at: 0,
      updated_at: 0,
    });

    const req = new Request('http://test/api/remote-agents/jobs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'win-01' }),
    });

    const res = await claimPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.id).toBe(10);
    expect(body.job.sourcePath).toBe('/library/a.mkv');
    expect(body.job.outputPath).toBe('/library/a-x265.mkv');
    expect(body.job.outputContainer).toBe('mkv');
    expect(body.lease.state).toBe('claimed');
  });

  it('claim reconciles expired claimed lease by requeueing', async () => {
    mockDb.remoteWorkerRepo.getActiveByWorkerId.mockReturnValue({ workerId: 'win-01' });
    mockDb.remoteJobLeaseRepo.listExpiredActive.mockReturnValue([
      { job_id: 71, state: 'claimed', progress_percent: 0, lease_expires_at: 1, worker_id: 'w', lease_token: 't' },
    ]);
    mockDb.jobRepo.findById.mockReturnValue({ id: 71, file_id: 90 });
    mockDb.jobRepo.requeueFromEncoding.mockReturnValue({ id: 71, status: 'queued' });
    mockDb.fileRepo.getById.mockReturnValue({ id: 90, version: 3 });
    mockDb.jobRepo.claimNext.mockReturnValue(undefined);

    const req = new Request('http://test/api/remote-agents/jobs/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'win-01' }),
    });

    const res = await claimPost(req);
    expect(res.status).toBe(200);
    expect(mockDb.jobRepo.requeueFromEncoding).toHaveBeenCalledWith(71, 'remote_lease_expired_requeued');
  });

  it('start rejects invalid lease', async () => {
    mockDb.remoteJobLeaseRepo.validateActiveLease.mockReturnValue(undefined);

    const req = new Request('http://test/api/remote-agents/jobs/44/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workerId: 'win-01', leaseToken: 'abc123456' }),
    });

    const res = await startPost(req, { params: Promise.resolve({ id: '44' }) });
    expect(res.status).toBe(409);
  });

  it('progress updates running lease', async () => {
    mockDb.remoteJobLeaseRepo.validateActiveLease.mockReturnValue({ job_id: 9 });
    mockDb.remoteJobLeaseRepo.setState.mockReturnValue({ job_id: 9, state: 'running' });

    const req = new Request('http://test/api/remote-agents/jobs/9/progress', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: 'win-01',
        leaseToken: 'abc123456',
        progressPercent: 40,
        message: 'encoding',
      }),
    });

    const res = await progressPost(req, { params: Promise.resolve({ id: '9' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lease.state).toBe('running');
  });

  it('complete success marks job done and emits done-smaller outcome', async () => {
    mockDb.remoteJobLeaseRepo.validateActiveLease.mockReturnValue({ job_id: 50 });
    mockDb.jobRepo.findById.mockReturnValue({ id: 50, file_id: 77 });
    mockDb.jobRepo.markCompleted.mockReturnValue({ id: 50, status: 'done' });
    mockDb.fileRepo.getById.mockReturnValue({ id: 77, version: 5 });
    mockDb.remoteJobLeaseRepo.setState.mockReturnValue({ job_id: 50, state: 'completed' });

    const req = new Request('http://test/api/remote-agents/jobs/50/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: 'win-01',
        leaseToken: 'abc123456',
        success: true,
        bytesIn: 1000,
        bytesOut: 700,
        durationMs: 1500,
      }),
    });

    const res = await completePost(req, { params: Promise.resolve({ id: '50' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('done-smaller');
  });

  it('complete failure marks job failed', async () => {
    mockDb.remoteJobLeaseRepo.validateActiveLease.mockReturnValue({ job_id: 51 });
    mockDb.jobRepo.findById.mockReturnValue({ id: 51, file_id: 78 });
    mockDb.jobRepo.markFailed.mockReturnValue({ id: 51, status: 'failed' });
    mockDb.fileRepo.getById.mockReturnValue({ id: 78, version: 2 });
    mockDb.remoteJobLeaseRepo.setState.mockReturnValue({ job_id: 51, state: 'failed' });

    const req = new Request('http://test/api/remote-agents/jobs/51/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        workerId: 'win-01',
        leaseToken: 'abc123456',
        success: false,
        exitCode: 3,
        errorMessage: 'ffmpeg failed',
      }),
    });

    const res = await completePost(req, { params: Promise.resolve({ id: '51' }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.job.status).toBe('failed');
  });
});
