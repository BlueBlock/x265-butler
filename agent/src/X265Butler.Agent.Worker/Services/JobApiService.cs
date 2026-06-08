using X265Butler.Agent.Contracts.Jobs;

namespace X265Butler.Agent.Worker.Services;

public sealed class JobApiService
{
    private readonly JobStateStore _store;
    private readonly JobValidationService _validation;

    public JobApiService(JobStateStore store, JobValidationService validation)
    {
        _store = store;
        _validation = validation;
    }

    public (RemoteJobDescriptor Descriptor, ValidateJobResponse Validation) Prepare(PrepareRemoteJobRequest request)
    {
        var descriptor = _store.Prepare(request);
        var validation = _validation.Validate(new ValidateJobRequest(request.SourcePath, request.CacheRoot));
        return (descriptor, validation);
    }

    public RemoteJobDescriptor? Get(string jobId) => _store.Get(jobId);

    public IReadOnlyCollection<RemoteJobDescriptor> List() => _store.List();

    public RemoteJobDescriptor? Claim(ClaimRemoteJobRequest request) => _store.Claim(request);

    public RemoteJobDescriptor? Start(string jobId, string workerClaimId) => _store.Start(jobId, workerClaimId);

    public RemoteJobDescriptor? Progress(UpdateRemoteJobProgressRequest request) => _store.Progress(request);

    public RemoteJobDescriptor? Complete(CompleteRemoteJobRequest request) => _store.Complete(request);
}