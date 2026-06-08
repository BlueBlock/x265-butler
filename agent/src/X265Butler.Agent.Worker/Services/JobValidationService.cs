using Microsoft.Extensions.Options;
using X265Butler.Agent.Contracts.Jobs;
using X265Butler.Agent.Worker.Options;

namespace X265Butler.Agent.Worker.Services;

public sealed class JobValidationService
{
    private readonly AgentOptions _options;
    private readonly SmbPathMapper _pathMapper;

    public JobValidationService(IOptions<AgentOptions> options, SmbPathMapper pathMapper)
    {
        _options = options.Value;
        _pathMapper = pathMapper;
    }

    public ValidateJobResponse Validate(ValidateJobRequest request)
    {
        var messages = new List<string>();

        var source = _pathMapper.Resolve(request.SourcePath);
        var cache = _pathMapper.Resolve(request.CacheRoot);

        var sourceLocalPath = source.LocalPath ?? request.SourcePath;
        var cacheLocalPath = cache.LocalPath ?? request.CacheRoot;

        if (!source.Mapped)
        {
            messages.Add($"No mapping rule matched source path '{request.SourcePath}'.");
        }

        if (!cache.Mapped)
        {
            messages.Add($"No mapping rule matched cache path '{request.CacheRoot}'.");
        }

        var sourceExists = File.Exists(sourceLocalPath) || Directory.Exists(sourceLocalPath);
        if (!sourceExists)
        {
            messages.Add($"Source path '{sourceLocalPath}' does not exist.");
        }

        var cacheExists = Directory.Exists(cacheLocalPath);
        if (!cacheExists)
        {
            messages.Add($"Cache root '{cacheLocalPath}' does not exist.");
        }

        var cacheWritable = cacheExists && ProbeWritable(cacheLocalPath, messages);
        var ffmpegAvailable = ProbeFfmpegAvailable(messages);

        return new ValidateJobResponse(
            sourceExists,
            cacheExists,
            cacheWritable,
            ffmpegAvailable,
            sourceLocalPath,
            cacheLocalPath,
            messages);
    }

    private bool ProbeFfmpegAvailable(List<string> messages)
    {
        try
        {
            using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
            {
                FileName = _options.FfmpegPath,
                Arguments = "-version",
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            });

            if (process is null)
            {
                messages.Add("ffmpeg process did not start.");
                return false;
            }

            process.WaitForExit(5000);
            if (process.ExitCode == 0)
            {
                return true;
            }

            messages.Add($"ffmpeg exited with code {process.ExitCode}.");
            return false;
        }
        catch (Exception ex)
        {
            messages.Add($"ffmpeg probe failed: {ex.Message}");
            return false;
        }
    }

    private static bool ProbeWritable(string directoryPath, List<string> messages)
    {
        try
        {
            var probePath = Path.Combine(directoryPath, $".x265-butler-agent-probe-{Guid.NewGuid():N}.tmp");
            File.WriteAllText(probePath, "ok");
            File.Delete(probePath);
            return true;
        }
        catch (Exception ex)
        {
            messages.Add($"Cache root is not writable: {ex.Message}");
            return false;
        }
    }
}