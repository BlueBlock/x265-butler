using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using X265Butler.Agent.Contracts.Capabilities;
using X265Butler.Agent.Worker.Options;

namespace X265Butler.Agent.Worker.Services;

public sealed class AgentCapabilityService
{
    private static readonly string[] EncoderIds = ["libx265", "hevc_nvenc", "hevc_qsv", "hevc_vaapi"];
    private readonly AgentOptions _options;
    private readonly SmbPathMapper _pathMapper;

    public AgentCapabilityService(IOptions<AgentOptions> options, SmbPathMapper pathMapper)
    {
        _options = options.Value;
        _pathMapper = pathMapper;
    }

    public async Task<AgentCapabilityReport> GetReportAsync(CancellationToken cancellationToken)
    {
        var ffmpegVersion = await ProbeFfmpegVersionAsync(cancellationToken);
        var ffmpegEncoders = await ProbeFfmpegEncodersAsync(cancellationToken);
        var nvidiaSmiAvailable = await CommandSucceedsAsync("nvidia-smi", "-L", cancellationToken);

        var encoders = EncoderIds.Select(id => BuildEncoderCapability(id, ffmpegEncoders, nvidiaSmiAvailable)).ToArray();

        return new AgentCapabilityReport(
            _options.AgentId,
            _options.DisplayName,
            Environment.MachineName,
            RuntimeInformation.OSDescription,
            _options.FfmpegPath,
            ffmpegVersion,
            _pathMapper.SharedStorageAccessible,
            DateTimeOffset.UtcNow,
            encoders);
    }

    private EncoderCapability BuildEncoderCapability(string id, ISet<string> ffmpegEncoders, bool nvidiaSmiAvailable)
    {
        var available = ffmpegEncoders.Contains(id);
        string? detail = null;

        if (id == "hevc_nvenc")
        {
            detail = available
                ? (nvidiaSmiAvailable ? "ffmpeg encoder present and nvidia-smi reachable" : "ffmpeg encoder present; nvidia-smi not found")
                : "ffmpeg encoder missing";
        }
        else if (!available)
        {
            detail = "ffmpeg encoder missing";
        }

        return new EncoderCapability(id, available, detail);
    }

    private async Task<string?> ProbeFfmpegVersionAsync(CancellationToken cancellationToken)
    {
        try
        {
            var startInfo = CreateStartInfo(_options.FfmpegPath, "-version");
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return null;
            }

            var line = await process.StandardOutput.ReadLineAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);
            return string.IsNullOrWhiteSpace(line) ? null : line.Trim();
        }
        catch
        {
            return null;
        }
    }

    private async Task<ISet<string>> ProbeFfmpegEncodersAsync(CancellationToken cancellationToken)
    {
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        try
        {
            var startInfo = CreateStartInfo(_options.FfmpegPath, "-hide_banner -encoders");
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return found;
            }

            while (!process.StandardOutput.EndOfStream)
            {
                var line = await process.StandardOutput.ReadLineAsync(cancellationToken);
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                foreach (Match match in Regex.Matches(line, @"\b(libx265|hevc_nvenc|hevc_qsv|hevc_vaapi)\b"))
                {
                    found.Add(match.Value);
                }
            }

            await process.WaitForExitAsync(cancellationToken);
        }
        catch
        {
            return found;
        }

        return found;
    }

    private static async Task<bool> CommandSucceedsAsync(string fileName, string arguments, CancellationToken cancellationToken)
    {
        try
        {
            var startInfo = CreateStartInfo(fileName, arguments);
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return false;
            }

            await process.WaitForExitAsync(cancellationToken);
            return process.ExitCode == 0;
        }
        catch
        {
            return false;
        }
    }

    private static ProcessStartInfo CreateStartInfo(string fileName, string arguments)
    {
        return new ProcessStartInfo
        {
            FileName = fileName,
            Arguments = arguments,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true
        };
    }
}