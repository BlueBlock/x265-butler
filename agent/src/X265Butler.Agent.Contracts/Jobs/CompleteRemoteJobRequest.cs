namespace X265Butler.Agent.Contracts.Jobs;

public sealed record CompleteRemoteJobRequest(string JobId, string WorkerClaimId, bool Success, string? Message);