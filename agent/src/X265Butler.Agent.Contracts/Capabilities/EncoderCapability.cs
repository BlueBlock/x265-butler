namespace X265Butler.Agent.Contracts.Capabilities;

public sealed record EncoderCapability(string Id, bool Available, string? Detail = null);