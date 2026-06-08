using X265Butler.Agent.Contracts.Paths;

namespace X265Butler.Agent.Worker.Options;

public sealed class AgentOptions
{
    public const string SectionName = "Agent";

    public string AgentId { get; set; } = Environment.MachineName;

    public string DisplayName { get; set; } = Environment.MachineName;

    public string FfmpegPath { get; set; } = "ffmpeg.exe";

    public string WorkRoot { get; set; } = @"C:\x265-butler-agent\work";

    public List<PathMapRule> PathMappings { get; set; } = new();
}