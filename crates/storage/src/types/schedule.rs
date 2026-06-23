/// A scheduled local runtime job.
///
/// Running jobs carry `lease_until`; another runtime may reclaim and re-run them after the lease
/// expires if the prior owner crashed before completing/failing/canceling the job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduledJob {
    pub job_id: String,
    pub kind: ScheduledFunctionKind,
    pub name: String,
    pub args: String,
    pub due_time: i64,
    pub state: ScheduledState,
    pub created_time: i64,
    pub updated_time: i64,
}

/// Convex function kind supported by the local scheduler.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledFunctionKind {
    Mutation,
    Action,
}

impl ScheduledFunctionKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Mutation => "mutation",
            Self::Action => "action",
        }
    }

    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "mutation" => Some(Self::Mutation),
            "action" => Some(Self::Action),
            _ => None,
        }
    }
}

/// Scheduled job lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduledState {
    Pending,
    Running { lease_until: i64 },
    Complete,
    Canceled,
    Failed,
}

impl ScheduledState {
    pub const CANCELED: &'static str = "canceled";
    pub const COMPLETE: &'static str = "complete";
    pub const FAILED: &'static str = "failed";
    pub const PENDING: &'static str = "pending";
    pub const RUNNING: &'static str = "running";

    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => Self::PENDING,
            Self::Running { .. } => Self::RUNNING,
            Self::Complete => Self::COMPLETE,
            Self::Canceled => Self::CANCELED,
            Self::Failed => Self::FAILED,
        }
    }

    #[must_use]
    pub fn decode(value: &str, lease_until: Option<i64>) -> Option<Self> {
        match (value, lease_until) {
            (Self::PENDING, None) => Some(Self::Pending),
            (Self::RUNNING, Some(lease_until)) => Some(Self::Running { lease_until }),
            (Self::COMPLETE, None) => Some(Self::Complete),
            (Self::CANCELED, None) => Some(Self::Canceled),
            (Self::FAILED, None) => Some(Self::Failed),
            _ => None,
        }
    }

    #[must_use]
    pub fn lease_until(&self) -> Option<i64> {
        match self {
            Self::Running { lease_until } => Some(*lease_until),
            _ => None,
        }
    }
}
