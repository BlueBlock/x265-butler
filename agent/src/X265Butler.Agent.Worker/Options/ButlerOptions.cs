namespace X265Butler.Agent.Worker.Options;

public sealed class ButlerOptions
{
    public const string SectionName = "Butler";

    public bool Enabled { get; set; } = false;

    public string BaseUrl { get; set; } = "http://localhost:3000";

    public string BearerToken { get; set; } = "change-me";

    public int PollIntervalSeconds { get; set; } = 5;

    public int RegisterIntervalSeconds { get; set; } = 30;

    public bool AllowValidationOnlySuccess { get; set; } = false;
}
