namespace X265Butler.Agent.Contracts.Jobs;

public enum RemoteJobState
{
    Prepared = 0,
    Claimed = 1,
    Running = 2,
    Completed = 3,
    Failed = 4,
    Cancelled = 5,
}