namespace X265Butler.Agent.Contracts.Jobs;

public sealed record ValidateJobResponse(
    bool SourceExists,
    bool CacheRootExists,
    bool CacheRootWritable,
    bool FfmpegAvailable,
    string? SourceLocalPath,
    string? CacheLocalPath,
    IReadOnlyList<string> Messages);