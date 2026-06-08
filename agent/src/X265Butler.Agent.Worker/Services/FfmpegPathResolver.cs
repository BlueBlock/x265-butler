using System.IO;

namespace X265Butler.Agent.Worker.Services;

public static class FfmpegPathResolver
{
    public static string Resolve(string configuredPath)
    {
        if (string.IsNullOrWhiteSpace(configuredPath))
        {
            return "ffmpeg.exe";
        }

        if (Path.IsPathRooted(configuredPath))
        {
            return configuredPath;
        }

        var baseDir = AppContext.BaseDirectory;
        var direct = Path.Combine(baseDir, configuredPath);
        if (File.Exists(direct))
        {
            return direct;
        }

        var bundled = Path.Combine(baseDir, "ffmpeg", "ffmpeg.exe");
        if (File.Exists(bundled))
        {
            return bundled;
        }

        return configuredPath;
    }
}
