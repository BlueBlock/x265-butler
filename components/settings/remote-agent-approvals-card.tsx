'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

type PendingEnrollment = {
  workerId: string;
  displayName: string;
  machineName: string | null;
  platform: string | null;
  capabilities: Record<string, unknown>;
  requestedAtIso: string;
  lastSeenAtIso: string;
};

type ApprovedEnrollment = {
  workerId: string;
  approvedAtIso: string;
};

type EnrollmentResponse = {
  pending: PendingEnrollment[];
  approved: ApprovedEnrollment[];
  pendingCount: number;
  approvedCount: number;
};

export function RemoteAgentApprovalsCard() {
  const [pending, setPending] = useState<PendingEnrollment[]>([]);
  const [approved, setApproved] = useState<ApprovedEnrollment[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyWorkerId, setBusyWorkerId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/remote-agents/enrollments', {
        method: 'GET',
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`load_failed_${response.status}`);
      }

      const data = (await response.json()) as EnrollmentResponse;
      setPending(data.pending ?? []);
      setApproved(data.approved ?? []);
    } catch (error) {
      toast.error('Failed to load pending agent enrollments.');
      console.error(error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approveOrReject = useCallback(
    async (workerId: string, action: 'approve' | 'reject') => {
      setBusyWorkerId(workerId);
      try {
        const response = await fetch(`/api/remote-agents/enrollments/${encodeURIComponent(workerId)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action }),
        });
        if (!response.ok) {
          throw new Error(`action_failed_${response.status}`);
        }

        toast.success(action === 'approve' ? `Approved ${workerId}.` : `Rejected ${workerId}.`);
        await refresh();
      } catch (error) {
        toast.error(`Failed to ${action} ${workerId}.`);
        console.error(error);
      } finally {
        setBusyWorkerId(null);
      }
    },
    [refresh],
  );

  const approvedSet = useMemo(() => new Set(approved.map((entry) => entry.workerId)), [approved]);

  return (
    <section className="rounded-md border border-border/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-sm">Remote Agent Approvals</h3>
          <p className="text-muted-foreground text-xs">
            Auto-enrolled agents stay pending until approved.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <p className="text-muted-foreground text-sm">Loading enrollments...</p>
      ) : pending.length === 0 ? (
        <p className="text-muted-foreground text-sm">No pending enrollments.</p>
      ) : (
        <div className="space-y-3">
          {pending.map((entry) => (
            <div key={entry.workerId} className="rounded border border-border/50 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{entry.displayName}</p>
                  <p className="font-mono text-xs text-muted-foreground">{entry.workerId}</p>
                  <p className="text-xs text-muted-foreground">
                    {entry.machineName || 'unknown host'} | {entry.platform || 'unknown platform'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    requested {new Date(entry.requestedAtIso).toLocaleString()} | seen{' '}
                    {new Date(entry.lastSeenAtIso).toLocaleString()}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button
                    size="sm"
                    onClick={() => void approveOrReject(entry.workerId, 'approve')}
                    disabled={busyWorkerId === entry.workerId}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void approveOrReject(entry.workerId, 'reject')}
                    disabled={busyWorkerId === entry.workerId}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {approved.length > 0 ? (
        <div className="mt-4 border-t border-border/40 pt-3">
          <p className="mb-2 font-medium text-xs text-muted-foreground">Approved workers</p>
          <div className="flex flex-wrap gap-2">
            {approved.map((entry) => (
              <span
                key={entry.workerId}
                className="rounded border border-border/50 px-2 py-1 font-mono text-xs"
                title={`approved ${new Date(entry.approvedAtIso).toLocaleString()}`}
              >
                {entry.workerId}
                {approvedSet.has(entry.workerId) ? '' : ''}
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}
