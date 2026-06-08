namespace X265Butler.Agent.Contracts.Jobs;

public sealed record ValidateJobRequest(string SourcePath, string CacheRoot);