using Microsoft.Extensions.Options;
using X265Butler.Agent.Contracts.Paths;
using X265Butler.Agent.Worker.Options;

namespace X265Butler.Agent.Worker.Services;

public sealed class SmbPathMapper
{
    private readonly IReadOnlyList<PathMapRule> _rules;

    public SmbPathMapper(IOptions<AgentOptions> options)
    {
        _rules = options.Value.PathMappings
            .OrderByDescending(rule => Normalize(rule.RemotePrefix).Length)
            .ToArray();
    }

    public bool SharedStorageAccessible => _rules.Count > 0 && _rules.All(rule => Directory.Exists(rule.LocalPrefix));

    public ResolvePathResponse Resolve(string remotePath)
    {
        if (string.IsNullOrWhiteSpace(remotePath))
        {
            return new ResolvePathResponse(false, remotePath, null, null, "Remote path is required.");
        }

        var normalizedRemote = Normalize(remotePath);

        foreach (var rule in _rules)
        {
            var normalizedPrefix = Normalize(rule.RemotePrefix);
            if (!normalizedRemote.StartsWith(normalizedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var suffix = normalizedRemote[normalizedPrefix.Length..].TrimStart('/');
            var localPath = suffix.Length == 0
                ? rule.LocalPrefix
                : Path.Combine(rule.LocalPrefix, suffix.Replace('/', Path.DirectorySeparatorChar));

            return new ResolvePathResponse(true, remotePath, localPath, rule.Name, null);
        }

        return new ResolvePathResponse(false, remotePath, null, null, "No path mapping matched the remote path.");
    }

    private static string Normalize(string path)
    {
        return path.Replace('\\', '/').TrimEnd('/');
    }
}