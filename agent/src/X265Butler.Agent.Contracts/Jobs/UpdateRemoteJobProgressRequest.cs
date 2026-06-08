namespace X265Butler.Agent.Contracts.Jobs;

public sealed record UpdateRemoteJobProgressRequest(string JobId, string WorkerClaimId, double ProgressPercent, string? Message);