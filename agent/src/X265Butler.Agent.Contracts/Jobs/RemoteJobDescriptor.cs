namespace X265Butler.Agent.Contracts.Jobs;

public sealed record RemoteJobDescriptor(
    string JobId,
    string SourcePath,
    string CacheRoot,
    string? OutputPath,
    string EncoderId,
    string? FfmpegArguments,
    RemoteJobState State,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset UpdatedAtUtc,
    double? ProgressPercent,
    string? WorkerClaimId,
    string? ResultMessage);