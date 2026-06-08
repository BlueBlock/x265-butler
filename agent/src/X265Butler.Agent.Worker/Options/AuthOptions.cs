namespace X265Butler.Agent.Worker.Options;

public sealed class AuthOptions
{
    public const string SectionName = "Auth";

    public bool Enabled { get; set; } = true;

    public string ApiKey { get; set; } = "change-me";
}