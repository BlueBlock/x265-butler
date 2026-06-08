using System.Diagnostics;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.Options;
using X265Butler.Agent.Contracts.Jobs;
using X265Butler.Agent.Worker.Options;

namespace X265Butler.Agent.Worker.Services;

public sealed class ButlerDispatchWorker : BackgroundService
{
    private readonly ILogger<ButlerDispatchWorker> _logger;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IOptionsMonitor<ButlerOptions> _butlerOptions;
    private readonly IOptionsMonitor<AgentOptions> _agentOptions;
    private readonly SmbPathMapper _pathMapper;
    private readonly AgentCapabilityService _capabilityService;
    private readonly JobValidationService _validationService;

    public ButlerDispatchWorker(
        ILogger<ButlerDispatchWorker> logger,
        IHttpClientFactory httpClientFactory,
        IOptionsMonitor<ButlerOptions> butlerOptions,
        IOptionsMonitor<AgentOptions> agentOptions,
        SmbPathMapper pathMapper,
        AgentCapabilityService capabilityService,
        JobValidationService validationService)
    {
        _logger = logger;
        _httpClientFactory = httpClientFactory;
        _butlerOptions = butlerOptions;
        _agentOptions = agentOptions;
        _pathMapper = pathMapper;
        _capabilityService = capabilityService;
        _validationService = validationService;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _logger.LogInformation("Butler dispatch worker started.");

        var lastRegisterUtc = DateTimeOffset.MinValue;

        while (!stoppingToken.IsCancellationRequested)
        {
            var options = _butlerOptions.CurrentValue;
            if (!options.Enabled)
            {
                await DelaySeconds(options.PollIntervalSeconds, stoppingToken);
                continue;
            }

            try
            {
                var client = CreateClient(options);

                var registerDue = DateTimeOffset.UtcNow >= lastRegisterUtc.AddSeconds(Math.Max(5, options.RegisterIntervalSeconds));
                if (registerDue)
                {
                    await RegisterWorkerAsync(client, stoppingToken);
                    lastRegisterUtc = DateTimeOffset.UtcNow;
                }

                var claim = await ClaimAsync(client, stoppingToken);
                if (claim.Job is null || claim.Lease is null)
                {
                    await DelaySeconds(options.PollIntervalSeconds, stoppingToken);
                    continue;
                }

                await StartAsync(client, claim.Job.Id, claim.Lease.LeaseToken, stoppingToken);
                await RunJobAsync(client, claim, stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Butler dispatch loop iteration failed.");
                await DelaySeconds(Math.Max(3, options.PollIntervalSeconds), stoppingToken);
            }
        }

        _logger.LogInformation("Butler dispatch worker stopped.");
    }

    private HttpClient CreateClient(ButlerOptions options)
    {
        var client = _httpClientFactory.CreateClient("butler");
        client.BaseAddress = new Uri(options.BaseUrl.TrimEnd('/') + "/");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", options.BearerToken);
        return client;
    }

    private async Task RegisterWorkerAsync(HttpClient client, CancellationToken cancellationToken)
    {
        var agent = _agentOptions.CurrentValue;
        var capabilities = await _capabilityService.GetReportAsync(cancellationToken);

        var payload = new
        {
            workerId = agent.AgentId,
            displayName = agent.DisplayName,
            baseUrl = "http://localhost:4120",
            capabilities = new
            {
                ffmpegPath = capabilities.FfmpegPath,
                sharedStorageAccessible = capabilities.SharedStorageAccessible,
                encoders = capabilities.Encoders.Where(e => e.Available).Select(e => e.Id).ToArray(),
            }
        };

        using var response = await client.PostAsJsonAsync("api/remote-agents/workers", payload, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException($"Worker register failed ({(int)response.StatusCode}): {body}");
        }
    }

    private async Task<ClaimResponse> ClaimAsync(HttpClient client, CancellationToken cancellationToken)
    {
        var agent = _agentOptions.CurrentValue;
        using var response = await client.PostAsJsonAsync(
            "api/remote-agents/jobs/claim",
            new { workerId = agent.AgentId },
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException($"Claim failed ({(int)response.StatusCode}): {body}");
        }

        var claim = await response.Content.ReadFromJsonAsync<ClaimResponse>(cancellationToken: cancellationToken);
        return claim ?? new ClaimResponse();
    }

    private async Task StartAsync(HttpClient client, int jobId, string leaseToken, CancellationToken cancellationToken)
    {
        var agent = _agentOptions.CurrentValue;
        using var response = await client.PostAsJsonAsync(
            $"api/remote-agents/jobs/{jobId}/start",
            new { workerId = agent.AgentId, leaseToken },
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException($"Start failed ({(int)response.StatusCode}): {body}");
        }
    }

    private async Task RunJobAsync(HttpClient client, ClaimResponse claim, CancellationToken cancellationToken)
    {
        var agent = _agentOptions.CurrentValue;
        var options = _butlerOptions.CurrentValue;
        var job = claim.Job!;
        var lease = claim.Lease!;
        var ffmpegPath = FfmpegPathResolver.Resolve(agent.FfmpegPath);

        var validation = _validationService.Validate(new ValidateJobRequest(job.SourcePath, job.CacheRoot));
        if (!validation.SourceExists || !validation.CacheRootExists || !validation.CacheRootWritable || !validation.FfmpegAvailable)
        {
            await CompleteAsync(client, job.Id, lease.LeaseToken, false, string.Join(" | ", validation.Messages), cancellationToken);
            return;
        }

        if (options.AllowValidationOnlySuccess)
        {
            await CompleteAsync(
                client,
                job.Id,
                lease.LeaseToken,
                true,
                "validation-only simulated completion",
                cancellationToken);
            return;
        }

        var sourceLocalPath = validation.SourceLocalPath;
        if (string.IsNullOrWhiteSpace(sourceLocalPath) || !File.Exists(sourceLocalPath))
        {
            await CompleteAsync(client, job.Id, lease.LeaseToken, false, "source file does not exist on worker", cancellationToken);
            return;
        }

        var sourceLength = TryGetSourceLength(sourceLocalPath);

        var outputLocalPath = ResolveOutputLocalPath(job.OutputPath, job.Id, validation.CacheLocalPath, agent.WorkRoot);
        if (string.IsNullOrWhiteSpace(outputLocalPath))
        {
            await CompleteAsync(client, job.Id, lease.LeaseToken, false, "output path could not be mapped on worker", cancellationToken);
            return;
        }

        var outputDir = Path.GetDirectoryName(outputLocalPath);
        if (string.IsNullOrWhiteSpace(outputDir))
        {
            await CompleteAsync(client, job.Id, lease.LeaseToken, false, "output directory is invalid", cancellationToken);
            return;
        }

        Directory.CreateDirectory(outputDir);

        await ProgressAsync(client, job.Id, lease.LeaseToken, 8, "validated", cancellationToken);

        var ffmpegResult = await ExecuteFfmpegAsync(
            job,
            lease,
            sourceLocalPath,
            outputLocalPath,
            ffmpegPath,
            client,
            cancellationToken);

        if (ffmpegResult.Success)
        {
            var bytesOut = TryGetSourceLength(outputLocalPath);
            if (bytesOut <= 0)
            {
                await CompleteAsync(
                    client,
                    job.Id,
                    lease.LeaseToken,
                    false,
                    "ffmpeg reported success but output artifact is missing/empty",
                    cancellationToken,
                    exitCode: 2,
                    logTail: ffmpegResult.LogTail);
                return;
            }

            await CompleteAsync(
                client,
                job.Id,
                lease.LeaseToken,
                true,
                "ffmpeg completed",
                cancellationToken,
                bytesIn: sourceLength,
                bytesOut: bytesOut,
                durationMs: ffmpegResult.DurationMs);

            _logger.LogInformation("Completed job {JobId}: bytesIn={BytesIn}, bytesOut={BytesOut}.", job.Id, sourceLength, bytesOut);
            return;
        }

        await CompleteAsync(
            client,
            job.Id,
            lease.LeaseToken,
            false,
            ffmpegResult.ErrorMessage,
            cancellationToken,
            exitCode: ffmpegResult.ExitCode,
            logTail: ffmpegResult.LogTail);
    }

    private async Task<FfmpegRunResult> ExecuteFfmpegAsync(
        ClaimedJob job,
        LeaseInfo lease,
        string sourceLocalPath,
        string outputPath,
        string ffmpegPath,
        HttpClient client,
        CancellationToken cancellationToken)
    {
        var durationMs = await ProbeDurationMsAsync(ffmpegPath, sourceLocalPath, cancellationToken);

        var args = BuildFfmpegArgs(job, sourceLocalPath, outputPath);
        var startInfo = new ProcessStartInfo
        {
            FileName = ffmpegPath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        foreach (var arg in args)
        {
            startInfo.ArgumentList.Add(arg);
        }

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            return new FfmpegRunResult(false, 1, 0, "ffmpeg failed to start", null);
        }

        using var killRegistration = cancellationToken.Register(() =>
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
            }
            catch
            {
                // ignored while shutting down
            }
        });

        var stderrTail = new Queue<string>();
        var latestProgress = 8d;
        var stdoutTask = ReadProgressStreamAsync(
            process.StandardOutput,
            job,
            lease,
            client,
            durationMs,
            progress => latestProgress = progress,
            cancellationToken);
        var stderrTask = ReadStderrTailAsync(process.StandardError, stderrTail, cancellationToken);
        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var heartbeatTask = EmitHeartbeatAsync(client, job, lease, () => latestProgress, heartbeatCts.Token);

        var stopwatch = Stopwatch.StartNew();
        await process.WaitForExitAsync(cancellationToken);
        stopwatch.Stop();

        heartbeatCts.Cancel();
        await Task.WhenAll(stdoutTask, stderrTask, heartbeatTask);

        if (process.ExitCode == 0)
        {
            return new FfmpegRunResult(true, 0, (int)stopwatch.ElapsedMilliseconds, string.Empty, null);
        }

        var tail = string.Join(Environment.NewLine, stderrTail);
        var message = string.IsNullOrWhiteSpace(tail)
            ? $"ffmpeg exited with code {process.ExitCode}"
            : $"ffmpeg exited with code {process.ExitCode}";
        return new FfmpegRunResult(false, process.ExitCode, (int)stopwatch.ElapsedMilliseconds, message, tail);
    }

    private async Task ReadProgressStreamAsync(
        StreamReader reader,
        ClaimedJob job,
        LeaseInfo lease,
        HttpClient client,
        long? durationMs,
        Action<double> onProgress,
        CancellationToken cancellationToken)
    {
        var lastProgress = 8d;
        var lastSentAt = DateTimeOffset.MinValue;

        while (!reader.EndOfStream && !cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync();
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            if (line.StartsWith("out_time_ms=", StringComparison.OrdinalIgnoreCase))
            {
                var raw = line["out_time_ms=".Length..];
                if (long.TryParse(raw, out var outTimeUs) && outTimeUs > 0)
                {
                    var outTimeMs = outTimeUs / 1000d;
                    var progress = durationMs is > 0
                        ? Math.Clamp((outTimeMs / durationMs.Value) * 90d, 9d, 98d)
                        : Math.Clamp(lastProgress + 1d, 9d, 95d);

                    var now = DateTimeOffset.UtcNow;
                    if (progress - lastProgress >= 2d || (now - lastSentAt).TotalSeconds >= 5)
                    {
                        lastProgress = progress;
                        onProgress(progress);
                        lastSentAt = now;
                        await ProgressAsync(client, job.Id, lease.LeaseToken, progress, $"encoding {progress:F0}%", cancellationToken);
                    }
                }
            }
            else if (line.Equals("progress=end", StringComparison.OrdinalIgnoreCase))
            {
                onProgress(99);
                await ProgressAsync(client, job.Id, lease.LeaseToken, 99, "finishing", cancellationToken);
            }
        }
    }

    private async Task EmitHeartbeatAsync(
        HttpClient client,
        ClaimedJob job,
        LeaseInfo lease,
        Func<double> currentProgress,
        CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(TimeSpan.FromSeconds(20), cancellationToken);
                if (cancellationToken.IsCancellationRequested)
                {
                    break;
                }

                var p = Math.Clamp(currentProgress(), 0, 99);
                await ProgressAsync(client, job.Id, lease.LeaseToken, p, "heartbeat", cancellationToken);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Lease heartbeat update failed for job {JobId}.", job.Id);
            }
        }
    }

    private static async Task ReadStderrTailAsync(StreamReader reader, Queue<string> stderrTail, CancellationToken cancellationToken)
    {
        while (!reader.EndOfStream && !cancellationToken.IsCancellationRequested)
        {
            var line = await reader.ReadLineAsync();
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }

            if (stderrTail.Count >= 80)
            {
                stderrTail.Dequeue();
            }

            stderrTail.Enqueue(line);
        }
    }

    private static IReadOnlyList<string> BuildFfmpegArgs(ClaimedJob job, string inputPath, string outputPath)
    {
        if (job.FfmpegArgs is { Count: > 0 })
        {
            return job.FfmpegArgs
                .Select(arg =>
                {
                    if (string.Equals(arg, "{input}", StringComparison.OrdinalIgnoreCase)) return inputPath;
                    if (string.Equals(arg, "{output}", StringComparison.OrdinalIgnoreCase)) return outputPath;
                    return arg;
                })
                .ToArray();
        }

        var codec = NormalizeEncoder(job.Encoder);
        var crf = job.Crf;
        var preset = string.IsNullOrWhiteSpace(job.Preset) ? null : job.Preset;

        var args = new List<string>
        {
            "-y",
            "-hide_banner",
            "-progress",
            "pipe:1",
            "-nostats",
            "-i",
            inputPath,
            "-map",
            "0",
            "-c:v",
            codec.VideoCodec,
        };

        foreach (var tuningArg in codec.ResolveTuningArgs(crf, preset))
        {
            args.Add(tuningArg);
        }

        args.Add("-c:a");
        args.Add("copy");
        args.Add("-c:s");
        args.Add("copy");
        args.Add(outputPath);

        return args;
    }

    private static EncoderPlan NormalizeEncoder(string encoder)
    {
        var key = encoder.Trim().ToLowerInvariant();
        return key switch
        {
            "hevc_nvenc" or "nvenc" => new EncoderPlan("hevc_nvenc", static (crf, preset) => ["-preset", preset ?? "p5", "-cq", (crf ?? 28).ToString(System.Globalization.CultureInfo.InvariantCulture)]),
            "hevc_qsv" or "qsv" => new EncoderPlan("hevc_qsv", static (crf, _) => ["-global_quality", (crf ?? 26).ToString(System.Globalization.CultureInfo.InvariantCulture)]),
            "hevc_vaapi" or "vaapi" => new EncoderPlan("hevc_vaapi", static (crf, _) => ["-qp", (crf ?? 26).ToString(System.Globalization.CultureInfo.InvariantCulture)]),
            _ => new EncoderPlan("libx265", static (crf, preset) => ["-preset", preset ?? "medium", "-crf", (crf ?? 24).ToString(System.Globalization.CultureInfo.InvariantCulture)]),
        };
    }

    private static async Task<long?> ProbeDurationMsAsync(string ffmpegPath, string sourcePath, CancellationToken cancellationToken)
    {
        var ffprobePath = ffmpegPath.EndsWith("ffmpeg.exe", StringComparison.OrdinalIgnoreCase)
            ? Path.Combine(Path.GetDirectoryName(ffmpegPath) ?? string.Empty, "ffprobe.exe")
            : "ffprobe";

        var startInfo = new ProcessStartInfo
        {
            FileName = ffprobePath,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        startInfo.ArgumentList.Add("-v");
        startInfo.ArgumentList.Add("error");
        startInfo.ArgumentList.Add("-show_entries");
        startInfo.ArgumentList.Add("format=duration");
        startInfo.ArgumentList.Add("-of");
        startInfo.ArgumentList.Add("default=nokey=1:noprint_wrappers=1");
        startInfo.ArgumentList.Add(sourcePath);

        try
        {
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return null;
            }

            var output = await process.StandardOutput.ReadToEndAsync(cancellationToken);
            await process.WaitForExitAsync(cancellationToken);

            if (process.ExitCode != 0)
            {
                return null;
            }

            if (double.TryParse(output.Trim(), System.Globalization.CultureInfo.InvariantCulture, out var seconds) && seconds > 0)
            {
                return (long)(seconds * 1000d);
            }
        }
        catch
        {
            return null;
        }

        return null;
    }

    private static string ResolveWorkDirectory(string? cacheRoot, int jobId, string fallbackWorkRoot)
    {
        if (!string.IsNullOrWhiteSpace(cacheRoot) && Directory.Exists(cacheRoot))
        {
            return Path.Combine(cacheRoot, "x265-butler-agent", "jobs", jobId.ToString());
        }

        return Path.Combine(fallbackWorkRoot, $"job-{jobId}");
    }

    private string? ResolveOutputLocalPath(string? remoteOutputPath, int jobId, string? cacheLocalPath, string fallbackWorkRoot)
    {
        if (!string.IsNullOrWhiteSpace(remoteOutputPath))
        {
            var mapped = _pathMapper.Resolve(remoteOutputPath);
            if (mapped.Mapped && !string.IsNullOrWhiteSpace(mapped.LocalPath))
            {
                return mapped.LocalPath;
            }
        }

        var workDir = ResolveWorkDirectory(cacheLocalPath, jobId, fallbackWorkRoot);
        return Path.Combine(workDir, $"output-{jobId}.mkv");
    }

    private async Task ProgressAsync(
        HttpClient client,
        int jobId,
        string leaseToken,
        double progress,
        string message,
        CancellationToken cancellationToken)
    {
        var agent = _agentOptions.CurrentValue;
        using var response = await client.PostAsJsonAsync(
            $"api/remote-agents/jobs/{jobId}/progress",
            new
            {
                workerId = agent.AgentId,
                leaseToken,
                progressPercent = progress,
                message,
            },
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            throw new InvalidOperationException($"Progress failed ({(int)response.StatusCode}): {body}");
        }
    }

    private async Task CompleteAsync(
        HttpClient client,
        int jobId,
        string leaseToken,
        bool success,
        string message,
        CancellationToken cancellationToken,
        long bytesIn = 0,
        long bytesOut = 0,
        int durationMs = 0,
        int exitCode = 1,
        string? logTail = null)
    {
        var agent = _agentOptions.CurrentValue;

        HttpResponseMessage response;
        if (success)
        {
            response = await client.PostAsJsonAsync(
                $"api/remote-agents/jobs/{jobId}/complete",
                new
                {
                    workerId = agent.AgentId,
                    leaseToken,
                    success,
                    bytesIn,
                    bytesOut,
                    durationMs,
                    message,
                },
                cancellationToken);
        }
        else
        {
            response = await client.PostAsJsonAsync(
                $"api/remote-agents/jobs/{jobId}/complete",
                new
                {
                    workerId = agent.AgentId,
                    leaseToken,
                    success,
                    exitCode,
                    errorMessage = message,
                    logTail,
                    message,
                },
                cancellationToken);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                var body = await response.Content.ReadAsStringAsync(cancellationToken);
                throw new InvalidOperationException($"Complete failed ({(int)response.StatusCode}): {body}");
            }
        }
    }

    private static async Task DelaySeconds(int seconds, CancellationToken cancellationToken)
    {
        await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(seconds, 1, 300)), cancellationToken);
    }

    private static long TryGetSourceLength(string sourcePath)
    {
        try
        {
            if (File.Exists(sourcePath))
            {
                return new FileInfo(sourcePath).Length;
            }
        }
        catch
        {
            return 0;
        }

        return 0;
    }

    private sealed class ClaimResponse
    {
        public ClaimedJob? Job { get; set; }

        public LeaseInfo? Lease { get; set; }
    }

    private sealed class ClaimedJob
    {
        public int Id { get; set; }

        public int FileId { get; set; }

        public string SourcePath { get; set; } = string.Empty;

        public string Encoder { get; set; } = string.Empty;

        public string CacheRoot { get; set; } = "/cache";

        public string? OutputPath { get; set; }

        public string? OutputContainer { get; set; }

        public string? OutputMode { get; set; }

        public string? OutputSuffix { get; set; }

        public int? Crf { get; set; }

        public string? Preset { get; set; }

        public List<string>? FfmpegArgs { get; set; }
    }

    private sealed class LeaseInfo
    {
        public string WorkerId { get; set; } = string.Empty;

        public string LeaseToken { get; set; } = string.Empty;
    }

    private sealed record EncoderPlan(string VideoCodec, Func<int?, string?, IReadOnlyList<string>> ResolveTuningArgs);

    private sealed record FfmpegRunResult(
        bool Success,
        int ExitCode,
        int DurationMs,
        string ErrorMessage,
        string? LogTail);
}
