using System.Collections.Concurrent;
using X265Butler.Agent.Contracts.Jobs;

namespace X265Butler.Agent.Worker.Services;

public sealed class JobStateStore
{
    private readonly ConcurrentDictionary<string, RemoteJobDescriptor> _jobs = new(StringComparer.Ordinal);

    public RemoteJobDescriptor Prepare(PrepareRemoteJobRequest request)
    {
        var now = DateTimeOffset.UtcNow;
        var descriptor = new RemoteJobDescriptor(
            request.JobId,
            request.SourcePath,
            request.CacheRoot,
            request.OutputPath,
            request.EncoderId,
            request.FfmpegArguments,
            RemoteJobState.Prepared,
            now,
            now,
            null,
            null,
            null);

        _jobs[request.JobId] = descriptor;
        return descriptor;
    }

    public RemoteJobDescriptor? Get(string jobId)
    {
        _jobs.TryGetValue(jobId, out var descriptor);
        return descriptor;
    }

    public IReadOnlyCollection<RemoteJobDescriptor> List() => _jobs.Values.OrderBy(static job => job.CreatedAtUtc).ToArray();

    public RemoteJobDescriptor? Claim(ClaimRemoteJobRequest request)
    {
        return Update(request.JobId, current =>
        {
            if (current.State is not RemoteJobState.Prepared and not RemoteJobState.Claimed)
            {
                return current;
            }

            return current with
            {
                State = RemoteJobState.Claimed,
                WorkerClaimId = request.WorkerClaimId,
                UpdatedAtUtc = DateTimeOffset.UtcNow,
                ResultMessage = null,
            };
        });
    }

    public RemoteJobDescriptor? Start(string jobId, string workerClaimId)
    {
        return Update(jobId, current =>
        {
            if (!ClaimMatches(current, workerClaimId))
            {
                return current;
            }

            return current with
            {
                State = RemoteJobState.Running,
                UpdatedAtUtc = DateTimeOffset.UtcNow,
                ResultMessage = null,
            };
        });
    }

    public RemoteJobDescriptor? Progress(UpdateRemoteJobProgressRequest request)
    {
        return Update(request.JobId, current =>
        {
            if (!ClaimMatches(current, request.WorkerClaimId))
            {
                return current;
            }

            return current with
            {
                State = RemoteJobState.Running,
                ProgressPercent = Math.Clamp(request.ProgressPercent, 0, 100),
                UpdatedAtUtc = DateTimeOffset.UtcNow,
                ResultMessage = request.Message,
            };
        });
    }

    public RemoteJobDescriptor? Complete(CompleteRemoteJobRequest request)
    {
        return Update(request.JobId, current =>
        {
            if (!ClaimMatches(current, request.WorkerClaimId))
            {
                return current;
            }

            return current with
            {
                State = request.Success ? RemoteJobState.Completed : RemoteJobState.Failed,
                ProgressPercent = request.Success ? 100 : current.ProgressPercent,
                UpdatedAtUtc = DateTimeOffset.UtcNow,
                ResultMessage = request.Message,
            };
        });
    }

    private RemoteJobDescriptor? Update(string jobId, Func<RemoteJobDescriptor, RemoteJobDescriptor> updater)
    {
        while (_jobs.TryGetValue(jobId, out var current))
        {
            var updated = updater(current);
            if (_jobs.TryUpdate(jobId, updated, current))
            {
                return updated;
            }
        }

        return null;
    }

    private static bool ClaimMatches(RemoteJobDescriptor current, string workerClaimId)
    {
        return !string.IsNullOrWhiteSpace(workerClaimId) &&
               string.Equals(current.WorkerClaimId, workerClaimId, StringComparison.Ordinal);
    }
}