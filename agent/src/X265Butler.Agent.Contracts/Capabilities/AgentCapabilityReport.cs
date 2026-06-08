namespace X265Butler.Agent.Contracts.Capabilities;

public sealed record AgentCapabilityReport(
    string AgentId,
    string DisplayName,
    string Hostname,
    string Platform,
    string FfmpegPath,
    string? FfmpegVersion,
    bool SharedStorageAccessible,
    DateTimeOffset ReportedAtUtc,
    IReadOnlyList<EncoderCapability> Encoders);