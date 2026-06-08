using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using X265Butler.Agent.Contracts.Jobs;
using X265Butler.Agent.Contracts.Paths;
using X265Butler.Agent.Worker.Options;
using X265Butler.Agent.Worker.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseWindowsService();

builder.Services.Configure<AgentOptions>(builder.Configuration.GetSection(AgentOptions.SectionName));
builder.Services.Configure<AuthOptions>(builder.Configuration.GetSection(AuthOptions.SectionName));
builder.Services.Configure<ButlerOptions>(builder.Configuration.GetSection(ButlerOptions.SectionName));
builder.Services.AddHttpClient("butler");
builder.Services.AddSingleton<SmbPathMapper>();
builder.Services.AddSingleton<AgentCapabilityService>();
builder.Services.AddSingleton<JobValidationService>();
builder.Services.AddSingleton<JobStateStore>();
builder.Services.AddSingleton<JobApiService>();
builder.Services.AddHostedService<ButlerDispatchWorker>();

var app = builder.Build();

app.Use(async (context, next) =>
{
	var auth = context.RequestServices.GetRequiredService<IOptions<AuthOptions>>().Value;
	if (!auth.Enabled || context.Request.Path.StartsWithSegments("/health") || context.Request.Path == "/")
	{
		await next();
		return;
	}

	var provided = context.Request.Headers.Authorization.FirstOrDefault();
	if (provided?.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase) == true)
	{
		provided = provided[7..];
	}
	else
	{
		provided = context.Request.Headers["X-Butler-ApiKey"].FirstOrDefault();
	}

	if (!ApiKeyMatches(provided, auth.ApiKey))
	{
		context.Response.StatusCode = StatusCodes.Status401Unauthorized;
		await context.Response.WriteAsJsonAsync(new { error = "unauthorized" });
		return;
	}

	await next();
});

app.MapGet("/", () => Results.Ok(new
{
	service = "x265-butler-agent",
	status = "ok",
	docs = new[]
	{
		"/health",
		"/v1/capabilities",
		"/v1/path-maps/resolve",
		"/v1/jobs/validate",
		"/v1/jobs/prepare",
		"/v1/jobs/{id}",
		"/v1/jobs/{id}/claim",
		"/v1/jobs/{id}/start",
		"/v1/jobs/{id}/progress",
		"/v1/jobs/{id}/complete"
	}
}));

app.MapGet("/health", () => Results.Ok(new
{
	service = "x265-butler-agent",
	status = "ok",
	reportedAtUtc = DateTimeOffset.UtcNow
}));

app.MapGet("/v1/capabilities", async (AgentCapabilityService service, CancellationToken cancellationToken) =>
	Results.Ok(await service.GetReportAsync(cancellationToken)));

app.MapPost("/v1/path-maps/resolve", (ResolvePathRequest request, SmbPathMapper mapper) =>
{
	var result = mapper.Resolve(request.RemotePath);
	return Results.Ok(result);
});

app.MapPost("/v1/jobs/validate", (ValidateJobRequest request, JobValidationService service) =>
{
	var result = service.Validate(request);
	return Results.Ok(result);
});

app.MapGet("/v1/jobs", (JobApiService service) => Results.Ok(service.List()));

app.MapGet("/v1/jobs/{id}", (string id, JobApiService service) =>
{
	var job = service.Get(id);
	return job is null ? Results.NotFound() : Results.Ok(job);
});

app.MapPost("/v1/jobs/prepare", (PrepareRemoteJobRequest request, JobApiService service) =>
{
	var result = service.Prepare(request);
	return Results.Ok(result);
});

app.MapPost("/v1/jobs/{id}/claim", (string id, ClaimRemoteJobRequest request, JobApiService service) =>
{
	if (!string.Equals(id, request.JobId, StringComparison.Ordinal))
	{
		return Results.BadRequest(new { error = "job_id_mismatch" });
	}

	var job = service.Claim(request);
	return job is null ? Results.NotFound() : Results.Ok(job);
});

app.MapPost("/v1/jobs/{id}/start", (string id, ClaimRemoteJobRequest request, JobApiService service) =>
{
	if (!string.Equals(id, request.JobId, StringComparison.Ordinal))
	{
		return Results.BadRequest(new { error = "job_id_mismatch" });
	}

	var job = service.Start(id, request.WorkerClaimId);
	return job is null ? Results.NotFound() : Results.Ok(job);
});

app.MapPost("/v1/jobs/{id}/progress", (string id, UpdateRemoteJobProgressRequest request, JobApiService service) =>
{
	if (!string.Equals(id, request.JobId, StringComparison.Ordinal))
	{
		return Results.BadRequest(new { error = "job_id_mismatch" });
	}

	var job = service.Progress(request);
	return job is null ? Results.NotFound() : Results.Ok(job);
});

app.MapPost("/v1/jobs/{id}/complete", (string id, CompleteRemoteJobRequest request, JobApiService service) =>
{
	if (!string.Equals(id, request.JobId, StringComparison.Ordinal))
	{
		return Results.BadRequest(new { error = "job_id_mismatch" });
	}

	var job = service.Complete(request);
	return job is null ? Results.NotFound() : Results.Ok(job);
});

app.Run();

static bool ApiKeyMatches(string? provided, string expected)
{
	if (string.IsNullOrWhiteSpace(provided) || string.IsNullOrWhiteSpace(expected))
	{
		return false;
	}

	var providedBytes = Encoding.UTF8.GetBytes(provided);
	var expectedBytes = Encoding.UTF8.GetBytes(expected);

	if (providedBytes.Length != expectedBytes.Length)
	{
		return false;
	}

	return CryptographicOperations.FixedTimeEquals(providedBytes, expectedBytes);
}
