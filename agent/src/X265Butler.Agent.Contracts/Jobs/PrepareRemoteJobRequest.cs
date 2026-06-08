namespace X265Butler.Agent.Contracts.Jobs;

public sealed record PrepareRemoteJobRequest(
    string JobId,
    string SourcePath,
    string CacheRoot,
    string? OutputPath,
    string EncoderId,
    string? FfmpegArguments);