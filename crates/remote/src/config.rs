use std::{str::FromStr, sync::Arc, time::Duration};

use convex::base_client::AuthTokenFetcher;
use convex_sync_types::UdfPath;
use storage::RuntimeWireIdentity;
use url::Url;

use crate::{RemoteError, RemoteResult};

pub const EMBEDDED_PROTOCOL_VERSION: i64 = 25;

/// Reserved local partition key for unauthenticated data; non-hex so it never collides with a `hashValue` digest.
pub const EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY: &str = "unauthenticated";

#[derive(Debug, Clone)]
pub struct DeploymentUrl {
    sync: Url,
}

impl DeploymentUrl {
    pub fn parse(input: &str) -> RemoteResult<Self> {
        let original = Url::parse(input).map_err(|e| RemoteError::InvalidConfig(e.to_string()))?;
        if original.host_str().is_none() {
            return Err(RemoteError::InvalidConfig(
                "deployment url must include a host".to_owned(),
            ));
        }
        if original.path() != "/" || original.query().is_some() || original.fragment().is_some() {
            return Err(RemoteError::InvalidConfig(
                "deployment url must not include path, query, or fragment".to_owned(),
            ));
        }
        let mut sync = original.clone();
        let scheme = match original.scheme() {
            "https" => "wss",
            "http" => "ws",
            other => {
                return Err(RemoteError::InvalidConfig(format!(
                    "unsupported deployment url scheme {other}"
                )));
            }
        };
        sync.set_scheme(scheme).map_err(|()| {
            RemoteError::InvalidConfig("failed to set websocket scheme".to_owned())
        })?;
        sync.set_path("/api/sync");
        Ok(Self { sync })
    }

    #[must_use]
    pub fn sync_url(&self) -> Url {
        self.sync.clone()
    }
}

impl FromStr for DeploymentUrl {
    type Err = RemoteError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientId(String);

impl ClientId {
    pub fn new(value: impl Into<String>) -> RemoteResult<Self> {
        let value = value.into();
        if value.is_empty()
            || value
                .bytes()
                .any(|byte| !byte.is_ascii() || byte.is_ascii_control())
        {
            return Err(RemoteError::InvalidConfig(
                "client id must be non-empty visible ASCII".to_owned(),
            ));
        }
        Ok(Self(value))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Default for ClientId {
    fn default() -> Self {
        Self("convex-embedded-rust".to_owned())
    }
}

#[derive(Debug, Clone)]
pub struct RemoteTiming {
    pub receive_timeout: Duration,
    pub operation_timeout: Duration,
}

impl Default for RemoteTiming {
    fn default() -> Self {
        Self {
            receive_timeout: Duration::from_millis(50),
            operation_timeout: Duration::from_secs(30),
        }
    }
}

#[derive(Default)]
pub enum RemoteAuth {
    #[default]
    None,
    Fetcher(Arc<AuthTokenFetcher>),
}

pub struct RemoteConfig {
    pub deployment_url: DeploymentUrl,
    pub client_id: ClientId,
    pub author_client_id: ClientId,
    pub auth: RemoteAuth,
    /// Prior runtime identities whose locally-authored mutations the current build explicitly
    /// declares replay-compatible. Matching is exact; durable envelopes are never rewritten.
    pub compatible_prior_runtimes: Vec<RuntimeWireIdentity>,
    pub runtime: RuntimeWireIdentity,
    pub timing: RemoteTiming,
}

impl RemoteConfig {
    #[must_use]
    pub fn new(deployment_url: DeploymentUrl) -> Self {
        Self {
            deployment_url,
            client_id: ClientId::default(),
            author_client_id: ClientId::default(),
            auth: RemoteAuth::None,
            compatible_prior_runtimes: Vec::new(),
            runtime: RuntimeWireIdentity {
                schema_hash: "local".to_owned(),
                module_graph_hash: "local".to_owned(),
                protocol_version: EMBEDDED_PROTOCOL_VERSION,
            },
            timing: RemoteTiming::default(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFunction(UdfPath);

impl RemoteFunction {
    pub fn parse(input: &str) -> RemoteResult<Self> {
        input
            .parse()
            .map(Self)
            .map_err(|e| RemoteError::InvalidConfig(format!("invalid function path: {e}")))
    }

    #[must_use]
    pub fn into_udf_path(self) -> UdfPath {
        self.0
    }
}

impl FromStr for RemoteFunction {
    type Err = RemoteError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Self::parse(s)
    }
}

#[cfg(test)]
mod tests {
    use super::EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY;

    #[test]
    fn unauthenticated_identity_key_equals_packages_embedded_src_protocol_ts() {
        assert_eq!(EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY, "unauthenticated");
    }
}
