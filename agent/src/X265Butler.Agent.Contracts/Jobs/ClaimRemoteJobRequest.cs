namespace X265Butler.Agent.Contracts.Jobs;

public sealed record ClaimRemoteJobRequest(string JobId, string WorkerClaimId);