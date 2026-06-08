namespace X265Butler.Agent.Contracts.Paths;

public sealed record ResolvePathResponse(bool Mapped, string RemotePath, string? LocalPath, string? RuleName, string? Message);