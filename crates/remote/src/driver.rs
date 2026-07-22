use std::sync::Mutex;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fmt::Write as _,
    sync::Arc,
    time::Duration,
};

use convex::{
    base_client::{AuthTokenFetcher, BaseConvexClient, FunctionResult},
    AuthenticationToken, Value,
};
use convex_sync_types::SessionId;
use sha2::{Digest, Sha256};
use storage::{
    AuthoritativeRow, DirtyHeadToken, IdMappingContent, PendingUpload, PushEnvelope, PushOutcome,
    PushResponse, UploadLeaseWrite,
};
#[cfg(not(target_arch = "wasm32"))]
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use uuid::Uuid;

use crate::{
    codec,
    config::{
        RemoteAuth, RemoteConfig, RemoteFunction, EMBEDDED_PROTOCOL_VERSION,
        EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY,
    },
    protocol, pull, push,
    store::{RemoteClock, RemoteStore, RemoteStoreFuture},
    transport::{ConnectRequest, RemoteTransport, TransportEvent},
    upload,
    upload::{RemoteUploadRequest, RemoteUploader},
    ConvexArgs, RemoteError, RemotePending, RemoteResult, RemoteTick,
};

const RECEIVE_DRAIN_LIMIT: usize = 4;
const REPLAY_INFLIGHT_LIMIT: usize = 64;
const REMOTE_RECEIPT_LIMIT: usize = 64;
const UPLOAD_DRAIN_LIMIT: usize = 4;
const MAX_CHECKPOINT_CHUNKS: usize = 32;
const MAX_CHECKPOINT_PAYLOADS: usize = 512;
#[cfg(not(target_arch = "wasm32"))]
const RECONNECT_RETRY_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteDocPushState {
    Blocked,
    Settled,
    Stale,
}

#[derive(Debug, Clone)]
pub struct RemoteDocPush {
    pub state: RemoteDocPushState,
    pub tick: RemoteTick,
}

/// The pull subscription a client publishes (§11 D3): the query `fn(args)` the server re-runs to
/// authorize, scope, and pull initial state. The server, not the client, computes each read-set, so the
/// client publishes exact query descriptors rather than a client-computed range.
#[derive(Debug, Clone, PartialEq)]
pub struct RemoteSubscription {
    /// The `FunctionReference` path of the app query the server re-runs for this subscription.
    pub pull_fn: String,
    /// The query's args after validator-derived local ids have been translated to hosted ids.
    pub pull_args: serde_json::Value,
    /// TS-authoritative retained-result cache key (Cut 7 §1/§14), stored verbatim by the pull apply;
    /// `None` when the publishing caller carries no retained-result key.
    pub result_cache_key: Option<String>,
    pub cursor: Option<RemoteCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteCursor {
    pub path: String,
    pub boundary: serde_json::Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct RemoteScope {
    pub subscriptions: Vec<RemoteSubscription>,
}

fn remote_subscription_key(subscription: &RemoteSubscription) -> RemoteResult<String> {
    serde_json::to_string(&(
        &subscription.pull_fn,
        &subscription.pull_args,
        subscription
            .cursor
            .as_ref()
            .map(|cursor| (&cursor.path, &cursor.boundary)),
    ))
    .map_err(|error| {
        RemoteError::Protocol(format!("pull subscription could not be encoded: {error}"))
    })
}

#[cfg(not(target_arch = "wasm32"))]
pub(crate) enum RemoteCommand {
    PullOnce {
        response: oneshot::Sender<RemoteResult<RemoteTick>>,
    },
    DocPush {
        table: String,
        local_document_id: String,
        token: DirtyHeadToken,
        response: oneshot::Sender<RemoteResult<RemoteDocPush>>,
    },
    ScopeWrite {
        scope: RemoteScope,
        response: oneshot::Sender<RemoteResult<()>>,
    },
    Identity {
        response: oneshot::Sender<RemoteResult<String>>,
    },
    Close {
        response: oneshot::Sender<RemoteResult<()>>,
    },
}

#[cfg(not(target_arch = "wasm32"))]
type DefaultRemoteStore = Arc<storage::EmbeddedStore>;
#[cfg(not(target_arch = "wasm32"))]
type DefaultRemoteClock = crate::store::SystemRemoteClock;
#[cfg(not(target_arch = "wasm32"))]
type DefaultRemoteUploader = upload::HttpRemoteUploader;

#[cfg(target_arch = "wasm32")]
type DefaultRemoteStore = Arc<storage::EmbeddedStore>;
#[cfg(target_arch = "wasm32")]
type DefaultRemoteClock = crate::store::UnavailableRemoteClock;
#[cfg(target_arch = "wasm32")]
type DefaultRemoteUploader = upload::UnavailableRemoteUploader;

#[allow(clippy::struct_excessive_bools)]
pub struct RemoteDriver<
    T: RemoteTransport,
    S = DefaultRemoteStore,
    C = DefaultRemoteClock,
    U = DefaultRemoteUploader,
> {
    auth_configured: bool,
    base: BaseConvexClient,
    clock: C,
    config: RemoteConfig,
    connection_count: u32,
    connected: bool,
    last_close_reason: String,
    pull_subscriptions: Vec<PullSubscription>,
    scope_tick: RemoteTick,
    table_names: Option<Vec<String>>,
    receipt_queue_empty: bool,
    push_queue_empty: bool,
    pending_checkpoints: VecDeque<PendingCheckpoint>,
    remote_write_active: Option<ActiveRemoteWrite>,
    remote_write_order: VecDeque<String>,
    remote_write_paused: bool,
    remote_write_pending: BTreeMap<String, PendingRemoteWrite>,
    replay_inflight_discarding: bool,
    replay_inflight_invalidated: bool,
    replay_waiting_for_remote_write: bool,
    scope: RemoteScope,
    scope_pending_removals: BTreeSet<String>,
    inflight_remote_push: VecDeque<InflightRemotePush>,
    store: S,
    transport: T,
    uploader: U,
    #[cfg(test)]
    actor_trace: Arc<Mutex<Vec<&'static str>>>,
}

struct InflightRemotePush {
    kind: InflightRemotePushKind,
    result: oneshot::Receiver<FunctionResult>,
}

enum InflightRemotePushKind {
    Blob,
    Mutation {
        acknowledgements: Vec<String>,
        envelope: Box<PushEnvelope>,
    },
    Checkpoint {
        checkpoint_id: String,
    },
}

#[derive(Clone)]
struct SpeculativeCrdtPrefix {
    epoch: i64,
    head_seq: i64,
    payloads: Vec<Vec<u8>>,
    projection_hash: String,
}

#[derive(Clone)]
struct PendingCheckpoint {
    request: storage::CrdtCheckpointRequest,
    checkpoint: storage::CrdtCheckpoint,
}

struct PullSubscription {
    last_result: Option<FunctionResult>,
    /// The most recent retained result whose application failed for a permanent (non-transient)
    /// reason. A live manifest that keeps re-delivering unchanged — e.g. one whose checkpoint prefix no
    /// longer exists server-side — is reported once and then skipped until it changes, so the one-shot
    /// pull lane cannot hot-loop. Cleared as soon as any result applies cleanly.
    last_failed_result: Option<FunctionResult>,
    key: String,
    subscriber_id: convex::base_client::SubscriberId,
    cursor: Option<String>,
}

struct PendingRemoteWrite {
    checkpoint_responses: Vec<PendingCheckpoint>,
    crdt_changes: usize,
    pull_changes: usize,
    result: Option<FunctionResult>,
    subscription: String,
    write: RemoteWrite,
}

struct PreparedCrdt {
    change: Option<storage::RemoteCrdtChange>,
    checkpoint_response: Option<PendingCheckpoint>,
    blob: Option<storage::RemoteBlob>,
}

enum RemoteWrite {
    Page(storage::RemotePageWrite),
    SubscriptionDelete { now_ms: i64 },
}

struct ActiveRemoteWrite {
    future: RemoteStoreFuture<storage::RemotePageWriteResult>,
    pending: PendingRemoteWrite,
}

struct AcceptedIdentity {
    identity_json: Option<String>,
    identity_key: String,
    json: String,
}

fn parse_identity_response(json: &serde_json::Value) -> RemoteResult<AcceptedIdentity> {
    let received = json
        .get("protocolVersion")
        .and_then(serde_json::Value::as_f64);
    if received != Some(EMBEDDED_PROTOCOL_VERSION as f64) {
        let received = received.map_or_else(|| "missing".to_owned(), |value| value.to_string());
        return Err(RemoteError::DeploymentMismatch(format!(
            "embedded:identity protocol mismatch: expected {EMBEDDED_PROTOCOL_VERSION}, received {received}"
        )));
    }
    let identity_key = json
        .get("identityKey")
        .and_then(serde_json::Value::as_str)
        .filter(|value| !value.is_empty())
        .map_or_else(
            || EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY.to_owned(),
            str::to_owned,
        );
    let identity = json.get("identity").ok_or_else(|| {
        RemoteError::Protocol("embedded:identity result missing identity".to_owned())
    })?;
    let identity_json = if identity.is_null() {
        None
    } else {
        Some(serde_json::to_string(identity).map_err(|error| {
            RemoteError::Protocol(format!("embedded:identity snapshot was not JSON: {error}"))
        })?)
    };
    let json = serde_json::to_string(&json).map_err(|error| {
        RemoteError::Protocol(format!("embedded:identity result was not JSON: {error}"))
    })?;
    Ok(AcceptedIdentity {
        identity_json,
        identity_key,
        json,
    })
}

#[cfg(not(target_arch = "wasm32"))]
enum ActorEvent {
    Command(Option<RemoteCommand>),
    RemoteWrite(Result<storage::RemotePageWriteResult, storage::StorageError>),
    Reconnect,
    Transport(RemoteResult<TransportEvent>),
}

#[cfg(not(target_arch = "wasm32"))]
impl<T: RemoteTransport>
    RemoteDriver<
        T,
        Arc<storage::EmbeddedStore>,
        crate::SystemRemoteClock,
        upload::HttpRemoteUploader,
    >
{
    #[must_use]
    pub fn open(config: RemoteConfig, store: Arc<storage::EmbeddedStore>, transport: T) -> Self {
        Self::open_with_store(
            config,
            store,
            transport,
            crate::SystemRemoteClock::default(),
        )
    }
}

impl<T, S, C> RemoteDriver<T, S, C, DefaultRemoteUploader>
where
    T: RemoteTransport,
    S: RemoteStore,
    C: RemoteClock,
{
    #[must_use]
    pub fn open_with_store(config: RemoteConfig, store: S, transport: T, clock: C) -> Self {
        Self::open_with_store_and_uploader(
            config,
            store,
            transport,
            clock,
            DefaultRemoteUploader::default(),
        )
    }
}

impl<T, S, C, U> RemoteDriver<T, S, C, U>
where
    T: RemoteTransport,
    S: RemoteStore,
    C: RemoteClock,
    U: RemoteUploader,
{
    #[must_use]
    pub fn open_with_store_and_uploader(
        config: RemoteConfig,
        store: S,
        transport: T,
        clock: C,
        uploader: U,
    ) -> Self {
        Self {
            auth_configured: false,
            base: BaseConvexClient::new(),
            clock,
            config,
            connection_count: 0,
            connected: false,
            last_close_reason: "InitialConnect".to_owned(),
            pull_subscriptions: Vec::new(),
            scope_tick: RemoteTick::default(),
            table_names: None,
            receipt_queue_empty: false,
            push_queue_empty: false,
            pending_checkpoints: VecDeque::new(),
            remote_write_active: None,
            remote_write_order: VecDeque::new(),
            remote_write_paused: false,
            remote_write_pending: BTreeMap::new(),
            replay_inflight_discarding: false,
            replay_inflight_invalidated: false,
            replay_waiting_for_remote_write: false,
            scope: RemoteScope::default(),
            scope_pending_removals: BTreeSet::new(),
            inflight_remote_push: VecDeque::new(),
            store,
            transport,
            uploader,
            #[cfg(test)]
            actor_trace: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn pull(&mut self) -> RemoteResult<RemoteTick> {
        self.pull_interruptible(|| false).await
    }

    pub async fn pull_interruptible<F>(&mut self, mut should_yield: F) -> RemoteResult<RemoteTick>
    where
        F: FnMut() -> bool,
    {
        self.pull_with_receive_interruptible(&mut should_yield)
            .await
    }

    /// Run one browser-owned background pull step.
    ///
    /// Browser/WASM enters this actor when the transport host reports queued websocket ingress.
    /// It drains only that signaled ingress and never schedules a convergence poll.
    pub async fn pull_ready_interruptible<F>(
        &mut self,
        local_progress: bool,
        mut should_yield: F,
    ) -> RemoteResult<RemoteTick>
    where
        F: FnMut() -> bool,
    {
        let store_jobs_before = self.store.store_job_count();
        let mut tick = RemoteTick::default();
        tick.sent += self.ensure_connected().await?;
        let tables = self.schema_table_names()?;

        if local_progress && !should_yield() {
            tick.merge(self.drain_uploads().await?);
        }
        if !should_yield() {
            tick.merge(self.ensure_live_subscription(&tables, false).await?);
        }
        if should_yield() {
            tick.sent += self.flush_outbound().await?;
            self.record_store_jobs(&mut tick, store_jobs_before);
            self.pending_write(&mut tick)?;
            return Ok(tick);
        }

        for _ in 0..RECEIVE_DRAIN_LIMIT {
            let received = self
                .receive_once_with_timeout(Duration::from_millis(0))
                .await?;
            let received_message = remote_tick_should_drain_more(&received);
            tick.merge(received);
            tick.merge(self.remote_settlement_write()?);
            tick.merge(self.dispatch_ready_remote_pushes().await?);
            if should_yield() || !received_message {
                break;
            }

            tick.merge(self.queue_changed_subscription_results().await?);
            if should_yield() {
                break;
            }
        }

        tick.merge(self.drive_remote_write_with_ingress().await?);

        // A retained pull can expose a checkpoint request without changing the
        // app-query descriptor. Flush that already-authorized response in this
        // actor turn instead of waiting for a browser timer or another socket
        // transition.
        tick.merge(
            self.flush_checkpoint_responses_interruptible(&mut should_yield)
                .await?,
        );

        // Browser pulls are ingress-driven, so there may be no later foreground command after the
        // final mutation response. A terminal replay writes a durable settlement receipt; clear it
        // in this same actor turn once replay and checkpoint work are empty. Otherwise the browser
        // can project the authoritative row successfully while its exact pending snapshot remains
        // non-empty forever.
        if !should_yield() && !self.has_pending_push() {
            tick.merge(self.acknowledge_settlements().await?);
        }

        tick.sent += self.flush_outbound().await?;
        self.record_store_jobs(&mut tick, store_jobs_before);
        self.pending_write(&mut tick)?;
        Ok(tick)
    }

    async fn pull_with_receive_interruptible<F>(
        &mut self,
        should_yield: &mut F,
    ) -> RemoteResult<RemoteTick>
    where
        F: FnMut() -> bool,
    {
        let store_jobs_before = self.store.store_job_count();
        let mut tick = RemoteTick::default();
        tick.sent += self.ensure_connected().await?;
        let tables = self.schema_table_names()?;
        if !should_yield() {
            tick.merge(self.drain_uploads().await?);
        }
        if !should_yield() {
            tick.merge(
                self.push_after_remote_write_interruptible(should_yield)
                    .await?,
            );
        }
        if !should_yield() {
            tick.merge(self.ensure_live_subscription(&tables, true).await?);
        }
        if should_yield() {
            self.record_store_jobs(&mut tick, store_jobs_before);
            self.pending_write(&mut tick)?;
            return Ok(tick);
        }
        tick.merge(self.drain_ready_messages(should_yield).await?);
        tick.merge(self.drive_remote_write_with_ingress().await?);
        tick.merge(
            self.flush_checkpoint_responses_interruptible(should_yield)
                .await?,
        );
        self.record_store_jobs(&mut tick, store_jobs_before);
        self.pending_write(&mut tick)?;
        Ok(tick)
    }

    fn record_store_jobs(&self, tick: &mut RemoteTick, before: usize) {
        tick.store_jobs += self.store.store_job_count().saturating_sub(before);
    }

    fn pending_read(&self) -> RemoteResult<RemotePending> {
        let durable = self.store.remote_pending_read()?;
        let mut scope = BTreeSet::new();
        for subscription in &self.scope.subscriptions {
            let key = remote_subscription_key(subscription)?;
            let applied = self
                .pull_subscriptions
                .iter()
                .find(|active| active.key == key)
                .is_some_and(|active| active.last_result.is_some());
            if !applied {
                scope.insert(key);
            }
        }
        scope.extend(self.scope_pending_removals.iter().cloned());
        scope.extend(self.remote_write_pending.keys().cloned());
        if let Some(active) = &self.remote_write_active {
            scope.insert(active.pending.subscription.clone());
        }
        Ok(RemotePending {
            checkpoints: self.pending_checkpoints.len(),
            inflight: self.inflight_remote_push.len(),
            mutations: durable.mutations,
            scope: scope.len(),
            settlements: durable.settlements,
            uploads: durable.uploads,
        })
    }

    fn pending_write(&self, tick: &mut RemoteTick) -> RemoteResult<()> {
        tick.pending = Some(self.pending_read()?);
        Ok(())
    }

    async fn flush_checkpoint_responses_interruptible<F>(
        &mut self,
        should_yield: &mut F,
    ) -> RemoteResult<RemoteTick>
    where
        F: FnMut() -> bool,
    {
        if should_yield() || self.pending_checkpoints.is_empty() {
            return Ok(RemoteTick::default());
        }
        self.push_after_remote_write_interruptible(should_yield)
            .await
    }

    fn schema_table_names(&mut self) -> RemoteResult<Vec<String>> {
        if let Some(tables) = &self.table_names {
            return Ok(tables.clone());
        }
        let tables = self.store.schema_table_names()?;
        self.table_names = Some(tables.clone());
        Ok(tables)
    }

    async fn drain_ready_messages<F>(&mut self, should_yield: &mut F) -> RemoteResult<RemoteTick>
    where
        F: FnMut() -> bool,
    {
        let mut tick = RemoteTick::default();
        for _ in 0..RECEIVE_DRAIN_LIMIT {
            if should_yield() {
                break;
            }
            let received = self
                .receive_once_with_timeout(Duration::from_millis(0))
                .await?;
            let should_drain_more = remote_tick_should_drain_more(&received);
            tick.merge(received);
            tick.merge(self.remote_settlement_write()?);
            tick.merge(self.dispatch_ready_remote_pushes().await?);
            tick.merge(self.queue_changed_subscription_results().await?);
            if !should_drain_more || should_yield() {
                break;
            }
        }
        tick.sent += self.flush_outbound().await?;
        Ok(tick)
    }

    pub async fn close(&mut self) -> RemoteResult<()> {
        "ClientClose".clone_into(&mut self.last_close_reason);
        if let Err(error) = self.acknowledge_settlements().await {
            tracing::debug!(%error, "Embedded settlement acknowledgement did not finish before close");
        }
        self.pull_subscriptions_clear();
        self.flush_outbound().await?;
        self.connected = false;
        self.transport.close().await
    }

    pub fn scope_write(&mut self, scope: RemoteScope) -> RemoteResult<()> {
        let mut keyed = scope
            .subscriptions
            .into_iter()
            .filter(|subscription| !subscription.pull_fn.is_empty())
            .map(|subscription| Ok((remote_subscription_key(&subscription)?, subscription)))
            .collect::<RemoteResult<Vec<_>>>()?;
        keyed.sort_by(|left, right| left.0.cmp(&right.0));
        keyed.dedup_by(|left, right| left.0 == right.0);
        let scope = RemoteScope {
            subscriptions: keyed.iter().map(|(_, value)| value.clone()).collect(),
        };
        let desired = keyed
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<std::collections::BTreeSet<_>>();
        let persisted = self.store.remote_subscription_read()?;
        let persisted_matches = persisted.len() == desired.len()
            && persisted.iter().all(|key| desired.contains(key.as_str()));
        let active_matches = self.pull_subscriptions.len() == desired.len()
            && self
                .pull_subscriptions
                .iter()
                .all(|subscription| desired.contains(subscription.key.as_str()));
        if self.scope == scope && persisted_matches && active_matches {
            return Ok(());
        }

        let mut removed = persisted
            .into_iter()
            .filter(|key| !desired.contains(key.as_str()))
            .collect::<std::collections::BTreeSet<_>>();
        removed.extend(
            self.pull_subscriptions
                .iter()
                .filter(|subscription| !desired.contains(subscription.key.as_str()))
                .map(|subscription| subscription.key.clone()),
        );
        self.scope_pending_removals.extend(removed);
        self.scope = scope;
        Ok(())
    }

    async fn query(
        &mut self,
        path: RemoteFunction,
        args: ConvexArgs,
    ) -> RemoteResult<FunctionResult> {
        self.query_with_tick(path, args)
            .await
            .map(|(result, _tick)| result)
    }

    async fn query_with_tick(
        &mut self,
        path: RemoteFunction,
        args: ConvexArgs,
    ) -> RemoteResult<(FunctionResult, RemoteTick)> {
        let store_jobs_before = self.store.store_job_count();
        let mut tick = RemoteTick::default();
        tick.sent += self.ensure_connected().await?;
        let udf_path = path.into_udf_path();
        let subscriber_id = self.base.subscribe(udf_path, args);
        match self.flush_outbound().await {
            Ok(sent) => tick.sent += sent,
            Err(e) => {
                self.base.unsubscribe(subscriber_id);
                self.flush_outbound().await.ok();
                return Err(e);
            }
        }
        let deadline = self.deadline_after(self.config.timing.operation_timeout);
        let result = self.wait_for_query_result(subscriber_id, deadline).await;
        self.base.unsubscribe(subscriber_id);
        let flushed = self.flush_outbound().await;
        match result {
            Ok(result) => {
                tick.sent += flushed?;
                self.record_store_jobs(&mut tick, store_jobs_before);
                Ok((result, tick))
            }
            Err(e) => {
                flushed.ok();
                Err(e)
            }
        }
    }

    pub async fn identity(&mut self) -> RemoteResult<String> {
        self.refresh_auth().await?;
        let args = ConvexArgs::from([(
            "request".to_owned(),
            Value::Object(BTreeMap::from([(
                "kind".to_owned(),
                Value::String("identity".to_owned()),
            )])),
        )]);
        let result = self.query(protocol::pull_function()?, args).await?;
        let FunctionResult::Value(value) = result else {
            return Err(function_result_error(protocol::EMBEDDED_PULL, &result));
        };
        let accepted = parse_identity_response(&serde_json::Value::from(value))?;
        self.store
            .identity_write(&accepted.identity_key, accepted.identity_json.as_deref())?;
        Ok(accepted.json)
    }

    async fn mutation_with_tick(
        &mut self,
        path: RemoteFunction,
        args: ConvexArgs,
    ) -> RemoteResult<(FunctionResult, RemoteTick)> {
        let store_jobs_before = self.store.store_job_count();
        let mut tick = RemoteTick::default();
        tick.sent += self.ensure_connected().await?;
        let mut result = self.base.mutation(path.into_udf_path(), args);
        tick.sent += self.flush_outbound().await?;
        let deadline = self.deadline_after(self.config.timing.operation_timeout);
        loop {
            match result.try_recv() {
                Ok(result) => {
                    self.record_store_jobs(&mut tick, store_jobs_before);
                    return Ok((result, tick));
                }
                Err(oneshot::error::TryRecvError::Empty) => {}
                Err(oneshot::error::TryRecvError::Closed) if self.replay_inflight_discarding => {
                    continue;
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    return Err(RemoteError::Protocol(
                        "mutation response channel closed".to_owned(),
                    ));
                }
            }
            self.ensure_before(deadline, "mutation")?;
            tick.merge(self.receive_once_before(deadline, "mutation").await?);
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    #[allow(
        clippy::too_many_lines,
        reason = "the actor loop selects socket ingress, commands, deferred foreground work, and remote-write completion in one place"
    )]
    pub(crate) async fn run_with_observer<F>(
        mut self,
        mut commands: mpsc::Receiver<RemoteCommand>,
        observe: F,
    ) -> RemoteResult<()>
    where
        F: Fn(RemoteTick),
    {
        let mut deferred_commands = VecDeque::new();
        loop {
            if self.remote_write_active.is_none() {
                if let Some(command) = deferred_commands.pop_front() {
                    if self.run_command(command, &commands).await? {
                        return Ok(());
                    }
                    let tick = self.complete_actor_turn(RemoteTick::default()).await?;
                    if tick.has_observable_progress() {
                        observe(tick);
                    }
                    continue;
                }
            }

            let event = if !self.connected {
                if let Some(active) = self.remote_write_active.as_mut() {
                    tokio::select! {
                        applied = active.future.as_mut() => ActorEvent::RemoteWrite(applied),
                        command = commands.recv() => ActorEvent::Command(command),
                        () = tokio::time::sleep(RECONNECT_RETRY_DELAY) => ActorEvent::Reconnect,
                    }
                } else {
                    tokio::select! {
                        command = commands.recv() => ActorEvent::Command(command),
                        () = tokio::time::sleep(RECONNECT_RETRY_DELAY) => ActorEvent::Reconnect,
                    }
                }
            } else if let Some(active) = self.remote_write_active.as_mut() {
                let transport = &mut self.transport;
                tokio::select! {
                    applied = active.future.as_mut() => ActorEvent::RemoteWrite(applied),
                    command = commands.recv() => ActorEvent::Command(command),
                    received = transport.receive_wait() => ActorEvent::Transport(received),
                }
            } else {
                let transport = &mut self.transport;
                tokio::select! {
                    command = commands.recv() => ActorEvent::Command(command),
                    received = transport.receive_wait() => ActorEvent::Transport(received),
                }
            };
            match event {
                ActorEvent::Command(Some(command)) if self.remote_write_active.is_some() => {
                    match command {
                        command @ (RemoteCommand::Close { .. }
                        | RemoteCommand::ScopeWrite { .. }) => {
                            if self.run_command(command, &commands).await? {
                                return Ok(());
                            }
                        }
                        command => deferred_commands.push_back(command),
                    }
                }
                ActorEvent::Command(Some(command)) => {
                    if self.run_command(command, &commands).await? {
                        return Ok(());
                    }
                    let tick = self.complete_actor_turn(RemoteTick::default()).await?;
                    if tick.has_observable_progress() {
                        observe(tick);
                    }
                }
                ActorEvent::Command(None) => return Ok(()),
                ActorEvent::Reconnect => match self.reconnect(self.last_close_reason.clone()).await
                {
                    Ok(true) => {
                        let tick = self
                            .complete_actor_turn(RemoteTick {
                                connected: Some(true),
                                reconnected: true,
                                ..RemoteTick::default()
                            })
                            .await?;
                        if tick.has_observable_progress() {
                            observe(tick);
                        }
                    }
                    Ok(false) => observe(RemoteTick {
                        connected: Some(false),
                        ..RemoteTick::default()
                    }),
                    Err(error) => return Err(error),
                },
                ActorEvent::RemoteWrite(applied) => {
                    let written = self.complete_remote_write(applied)?;
                    let tick = if deferred_commands.is_empty() {
                        self.complete_actor_turn(written).await?
                    } else {
                        self.complete_actor_io(written).await?
                    };
                    if tick.has_observable_progress() {
                        observe(tick);
                    }
                }
                ActorEvent::Transport(received) => {
                    let received = self.receive_event(received).await?;
                    let tick = self.complete_actor_turn(received).await?;
                    if tick.has_observable_progress() {
                        observe(tick);
                    }
                }
            }
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn complete_actor_turn(&mut self, mut tick: RemoteTick) -> RemoteResult<RemoteTick> {
        tick.merge(self.complete_actor_io(RemoteTick::default()).await?);
        tick.merge(self.queue_changed_subscription_results().await?);
        self.pending_write(&mut tick)?;
        Ok(tick)
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn complete_actor_io(&mut self, mut tick: RemoteTick) -> RemoteResult<RemoteTick> {
        tick.sent += self.flush_outbound().await?;
        tick.merge(self.remote_settlement_write()?);
        tick.merge(self.dispatch_ready_remote_pushes().await?);
        if self.remote_write_active.is_none() {
            tick.merge(
                self.flush_checkpoint_responses_interruptible(&mut || false)
                    .await?,
            );
        }
        tick.sent += self.flush_outbound().await?;
        Ok(tick)
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn run_command(
        &mut self,
        command: RemoteCommand,
        commands: &mpsc::Receiver<RemoteCommand>,
    ) -> RemoteResult<bool> {
        match command {
            RemoteCommand::PullOnce { response } => {
                // PullOnce is the actor wake after a local store event. The store is shared with
                // the local runner, so durable queue hints computed by an earlier actor turn are
                // invalid once this command arrives.
                self.push_queue_empty = false;
                self.receipt_queue_empty = false;
                let result = match self.pull_interruptible(|| !commands.is_empty()).await {
                    Ok(mut tick) => match self.subscription_ready_write().await {
                        Ok(ready) => {
                            tick.merge(ready);
                            self.pending_write(&mut tick)?;
                            Ok(tick)
                        }
                        Err(error) => Err(error),
                    },
                    Err(error) => Err(error),
                };
                response.send(result).ok();
            }
            RemoteCommand::DocPush {
                table,
                local_document_id,
                token,
                response,
            } => {
                let result = self.doc_push(&table, &local_document_id, token).await;
                response.send(result).ok();
            }
            RemoteCommand::ScopeWrite { scope, response } => {
                response.send(self.scope_write(scope)).ok();
            }
            RemoteCommand::Identity { response } => {
                response.send(self.identity().await).ok();
            }
            RemoteCommand::Close { response } => {
                response.send(self.close().await).ok();
                return Ok(true);
            }
        }
        Ok(false)
    }

    async fn ensure_connected(&mut self) -> RemoteResult<usize> {
        self.ensure_auth_configured().await?;
        let mut sent = 0;
        if !self.connected {
            self.connect_transport().await?;
            sent += 1;
        }
        sent += self.flush_outbound().await?;
        Ok(sent)
    }

    async fn connect_transport(&mut self) -> RemoteResult<()> {
        let request = ConnectRequest {
            sync_url: self.config.deployment_url.sync_url(),
            client_id: self.config.client_id.clone(),
            session_id: SessionId::new(Uuid::new_v4()),
            connection_count: self.connection_count,
            last_close_reason: self.last_close_reason.clone(),
            max_observed_timestamp: self.base.max_observed_timestamp(),
            client_ts: Some(0),
        };
        self.transport.connect(request).await?;
        self.connected = true;
        Ok(())
    }

    async fn ensure_auth_configured(&mut self) -> RemoteResult<()> {
        if self.auth_configured {
            return Ok(());
        }
        self.refresh_auth().await
    }

    async fn refresh_auth(&mut self) -> RemoteResult<()> {
        match &self.config.auth {
            RemoteAuth::None => {}
            RemoteAuth::Fetcher(fetcher) => {
                let token = match (fetcher.as_ref())(false).await {
                    Ok(token) => token,
                    Err(e) => return Err(RemoteError::Auth(e.to_string())),
                };
                self.base
                    .set_auth_fetcher(Some(cached_first_token_fetcher(token, Arc::clone(fetcher))))
                    .await;
            }
        }
        self.auth_configured = true;
        Ok(())
    }

    async fn flush_outbound(&mut self) -> RemoteResult<usize> {
        let mut sent = 0;
        while let Some(message) = self.base.pop_next_message() {
            if let Err(e) = self.transport.send(message).await {
                self.reconnect(format!("TransportSendError: {e}")).await?;
                continue;
            }
            sent += 1;
        }
        Ok(sent)
    }

    async fn receive_once_before(
        &mut self,
        deadline: u64,
        operation: &'static str,
    ) -> RemoteResult<RemoteTick> {
        let timeout = self.receive_timeout_before(deadline, operation)?;
        self.receive_once_with_timeout(timeout).await
    }

    async fn receive_once_with_timeout(&mut self, timeout: Duration) -> RemoteResult<RemoteTick> {
        let event = self.transport.receive(timeout).await;
        let mut tick = self.receive_event(event).await?;
        tick.sent += self.flush_outbound().await?;
        tick.merge(self.remote_settlement_write()?);
        Ok(tick)
    }

    async fn receive_event(
        &mut self,
        event: RemoteResult<TransportEvent>,
    ) -> RemoteResult<RemoteTick> {
        let mut tick = RemoteTick::default();
        let event = match event {
            Ok(event) => event,
            Err(e) => {
                tick.reconnected = self
                    .reconnect(format!("TransportReceiveError: {e}"))
                    .await?;
                tick.connected = Some(tick.reconnected);
                if tick.reconnected {
                    tick.sent += self.flush_outbound().await?;
                }
                return Ok(tick);
            }
        };
        match event {
            TransportEvent::ServerMessage(message) => {
                tick.received = 1;
                #[cfg(test)]
                let trace_step = match &message {
                    convex_sync_types::ServerMessage::MutationResponse { .. } => {
                        "mutation_response"
                    }
                    convex_sync_types::ServerMessage::Transition { .. } => "transition",
                    _ => "ingress",
                };
                match self.base.receive_message(message) {
                    Ok(Some(_) | None) => {
                        #[cfg(test)]
                        self.actor_trace
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .push(trace_step);
                    }
                    Err(reason) => {
                        tick.reconnected = self.reconnect(reason).await?;
                        tick.connected = Some(tick.reconnected);
                        if tick.reconnected {
                            tick.sent += self.flush_outbound().await?;
                        }
                    }
                }
            }
            TransportEvent::Timeout => {}
            TransportEvent::Closed(reason) => {
                tick.reconnected = self.reconnect(reason).await?;
                tick.connected = Some(tick.reconnected);
                if tick.reconnected {
                    tick.sent += self.flush_outbound().await?;
                }
            }
        }
        Ok(tick)
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn subscription_ready_write(&mut self) -> RemoteResult<RemoteTick> {
        let tables = self.schema_table_names()?;
        let mut tick = self.ensure_live_subscription(&tables, false).await?;
        tick.merge(self.drive_remote_write_with_ingress().await?);
        tick.sent += self.flush_outbound().await?;
        Ok(tick)
    }

    #[cfg(not(target_arch = "wasm32"))]
    async fn drive_remote_write_with_ingress(&mut self) -> RemoteResult<RemoteTick> {
        let mut tick = RemoteTick::default();
        while let Some(active) = self.remote_write_active.as_mut() {
            let event = {
                let transport = &mut self.transport;
                tokio::select! {
                    biased;
                    applied = active.future.as_mut() => ActorEvent::RemoteWrite(applied),
                    received = transport.receive_wait() => ActorEvent::Transport(received),
                }
            };
            match event {
                ActorEvent::Transport(received) => {
                    let received = self.receive_event(received).await?;
                    tick.merge(received);
                    tick.sent += self.flush_outbound().await?;
                    tick.merge(self.remote_settlement_write()?);
                    tick.merge(self.queue_changed_subscription_results().await?);
                }
                ActorEvent::RemoteWrite(applied) => {
                    tick.merge(self.complete_remote_write(applied)?);
                    tick.merge(self.queue_changed_subscription_results().await?);
                    tick.sent += self.flush_outbound().await?;
                }
                ActorEvent::Command(_) | ActorEvent::Reconnect => unreachable!(),
            }
        }
        Ok(tick)
    }

    #[cfg(target_arch = "wasm32")]
    async fn drive_remote_write_with_ingress(&mut self) -> RemoteResult<RemoteTick> {
        let mut tick = RemoteTick::default();
        while let Some(active) = self.remote_write_active.as_mut() {
            let applied = active.future.as_mut().await;
            tick.merge(self.complete_remote_write(applied)?);
            tick.merge(self.queue_changed_subscription_results().await?);
            tick.sent += self.flush_outbound().await?;
        }
        Ok(tick)
    }

    fn remote_settlement_write(&mut self) -> RemoteResult<RemoteTick> {
        let mut tick = RemoteTick::default();
        while let Some(mut inflight) = self.inflight_remote_push.pop_front() {
            let result = match inflight.result.try_recv() {
                Ok(result) => result,
                Err(oneshot::error::TryRecvError::Empty) => {
                    self.inflight_remote_push.push_front(inflight);
                    break;
                }
                Err(oneshot::error::TryRecvError::Closed) if self.replay_inflight_discarding => {
                    continue;
                }
                Err(oneshot::error::TryRecvError::Closed) => {
                    return Err(RemoteError::Protocol(
                        "remote push response channel closed".to_owned(),
                    ));
                }
            };
            #[cfg(test)]
            self.actor_trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push("settlement");
            if self.replay_inflight_discarding {
                continue;
            }
            match inflight.kind {
                InflightRemotePushKind::Mutation {
                    acknowledgements,
                    envelope,
                } => {
                    if let Some(prior_outcome) = mutation_reuse_prior_outcome(&result) {
                        if prior_outcome == PushOutcome::Applied
                            || envelope.replay_id != envelope.mutation_id
                        {
                            return Err(function_result_error(protocol::EMBEDDED_PUSH, &result));
                        }
                        let replay_id = format!("replay:{}", Uuid::new_v4());
                        self.store.remote_push_replay_write(
                            &envelope.mutation_id,
                            envelope.commit_seq,
                            &envelope.replay_id,
                            &replay_id,
                            self.clock.now_ms()?,
                        )?;
                        // The prior attempt was terminal without applying app effects. Drain every
                        // request already sent behind it, then prepare the unchanged durable
                        // mutation again under the persisted replay id. Waiting for a changed pull
                        // result here can deadlock forever: a rejected attempt has no hosted
                        // aftermath, so an unchanged live subscription emits no new snapshot. A
                        // genuinely stale CRDT retry will still receive the ordinary `rebase`
                        // outcome, whose separate path waits for the authoritative page write.
                        self.replay_inflight_discarding = true;
                        self.replay_inflight_invalidated = false;
                        continue;
                    }
                    let (settlement, outcome) = self.complete_remote_push(
                        envelope.as_ref(),
                        &result,
                        RemoteTick::default(),
                    )?;
                    tick.merge(settlement);
                    if !acknowledgements.is_empty() {
                        self.store.remote_receipt_delete(&acknowledgements)?;
                        tick.receipts_pushed += acknowledgements.len();
                    }
                    if self.replay_waiting_for_remote_write {
                        // A rebase leaves the current durable envelope at the queue front. Drain
                        // the already-sent suffix before pulling and preparing it again; dropping
                        // those receivers would let a late hosted result poison the next attempt.
                        self.replay_inflight_discarding = true;
                        self.replay_inflight_invalidated = false;
                        continue;
                    }
                    if matches!(outcome, PushOutcome::Conflict | PushOutcome::Rejected) {
                        // Every request already in this window was prepared against the
                        // speculative effects of the rejected prefix. Keep their original
                        // receivers alive: same-field suffixes will return `rebase`, while
                        // independent suffixes may still settle normally. Re-dispatching here
                        // would race those already-sent mutations with a different replay
                        // fingerprint.
                        self.replay_inflight_invalidated = true;
                    }
                }
                InflightRemotePushKind::Checkpoint { checkpoint_id } => {
                    tick.merge(self.complete_checkpoint_push(
                        &checkpoint_id,
                        &result,
                        RemoteTick::default(),
                    )?);
                }
                InflightRemotePushKind::Blob => {
                    if !matches!(result, FunctionResult::Value(Value::Null)) {
                        return Err(function_result_error(protocol::EMBEDDED_PUSH, &result));
                    }
                }
            }
        }
        if self.inflight_remote_push.is_empty() {
            self.replay_inflight_discarding = false;
            self.replay_inflight_invalidated = false;
        }
        Ok(tick)
    }

    async fn queue_changed_subscription_results(&mut self) -> RemoteResult<RemoteTick> {
        if self.remote_write_active.is_some() {
            return Ok(RemoteTick::default());
        }
        let pending = self.pull_changed_results(&BTreeSet::new());
        let mut tick = RemoteTick::default();
        for (key, result) in pending {
            tick.pull_attempted += 1;
            tick.merge(self.enqueue_pull_result(result, &key).await?);
        }
        tick.merge(self.start_next_remote_write());
        Ok(tick)
    }

    async fn reconnect(&mut self, reason: String) -> RemoteResult<bool> {
        self.connected = false;
        self.connection_count = self.connection_count.saturating_add(1);
        self.last_close_reason = reason;
        if let Err(error) = self.connect_transport().await {
            if error.is_transient() {
                return Ok(false);
            }
            return Err(error);
        }
        if let RemoteAuth::Fetcher(fetcher) = &self.config.auth {
            let fetcher = Arc::clone(fetcher);
            let Ok(token) = (fetcher.as_ref())(true).await else {
                self.connected = false;
                return Ok(false);
            };
            self.base
                .set_auth_fetcher(Some(reconnect_token_fetcher(token, fetcher)))
                .await;
        }
        self.base.resend_ongoing_queries_mutations().await;
        Ok(true)
    }

    async fn ensure_live_subscription(
        &mut self,
        _tables: &[String],
        acknowledge: bool,
    ) -> RemoteResult<RemoteTick> {
        let mut tick = std::mem::take(&mut self.scope_tick);
        if acknowledge && !self.has_pending_push() {
            tick.merge(self.acknowledge_settlements().await?);
        }
        let (added, subscribed) = self.subscribe_missing().await?;
        tick.merge(subscribed);
        tick.merge(self.remove_retired_subscriptions()?);
        tick.sent += self.flush_outbound().await?;

        let mut pending = Vec::new();
        for (key, subscriber_id) in added {
            let deadline = self.deadline_after(self.config.timing.operation_timeout);
            let (result, query_tick) = self
                .wait_for_query_result_with_tick(subscriber_id, deadline)
                .await?;
            tick.merge(query_tick);
            pending.push((key, result));
        }
        let pending_keys = pending
            .iter()
            .map(|(key, _)| key.clone())
            .collect::<std::collections::BTreeSet<_>>();
        pending.extend(self.pull_changed_results(&pending_keys));
        for (key, result) in pending {
            tick.pull_attempted += 1;
            tick.merge(self.enqueue_pull_result(result, &key).await?);
        }
        tick.merge(self.start_next_remote_write());
        tick.sent += self.flush_outbound().await?;
        Ok(tick)
    }

    async fn subscribe_missing(
        &mut self,
    ) -> RemoteResult<(Vec<(String, convex::base_client::SubscriberId)>, RemoteTick)> {
        let mut added = Vec::new();
        let mut tick = RemoteTick::default();
        for subscription in self.scope.subscriptions.clone() {
            let key = remote_subscription_key(&subscription)?;
            if self
                .pull_subscriptions
                .iter()
                .any(|active| active.key == key)
            {
                continue;
            }
            let (active, subscribed) = self.pull_subscribe(subscription, key.clone()).await?;
            tick.merge(subscribed);
            added.push((key, active.subscriber_id));
            self.pull_subscriptions.push(active);
        }
        Ok((added, tick))
    }

    fn remove_retired_subscriptions(&mut self) -> RemoteResult<RemoteTick> {
        let desired = self
            .scope
            .subscriptions
            .iter()
            .map(remote_subscription_key)
            .collect::<RemoteResult<BTreeSet<_>>>()?;
        self.scope_pending_removals
            .retain(|key| !desired.contains(key));
        let tick = RemoteTick::default();
        for key in std::mem::take(&mut self.scope_pending_removals) {
            if self
                .remote_write_active
                .as_ref()
                .is_some_and(|active| active.pending.subscription == key)
            {
                self.scope_pending_removals.insert(key);
                continue;
            }
            if let Some(index) = self
                .pull_subscriptions
                .iter()
                .position(|subscription| subscription.key == key)
            {
                let active = self.pull_subscriptions.remove(index);
                self.base.unsubscribe(active.subscriber_id);
            }
            self.remote_write_pending.remove(&key);
            self.remote_write_order.retain(|queued| queued != &key);
            self.stage_remote_write(PendingRemoteWrite {
                checkpoint_responses: Vec::new(),
                crdt_changes: 0,
                pull_changes: 0,
                result: None,
                subscription: key,
                write: RemoteWrite::SubscriptionDelete {
                    now_ms: self.clock.now_ms()?,
                },
            });
        }
        Ok(tick)
    }

    async fn pull_subscribe(
        &mut self,
        subscription: RemoteSubscription,
        key: String,
    ) -> RemoteResult<(PullSubscription, RemoteTick)> {
        let (pull_args, cursor, mut tick) = self
            .resolve_subscription_cursor(&subscription, &key)
            .await?;
        let args = pull::args(&self.config.runtime, &subscription.pull_fn, &pull_args)?;
        tick.sent += self.ensure_connected().await?;
        let path = RemoteFunction::parse(&subscription.pull_fn)?.into_udf_path();
        let subscriber_id = self.base.subscribe(path, args);
        match self.flush_outbound().await {
            Ok(sent) => tick.sent += sent,
            Err(e) => {
                self.base.unsubscribe(subscriber_id);
                self.flush_outbound().await.ok();
                return Err(e);
            }
        }
        Ok((
            PullSubscription {
                last_result: None,
                last_failed_result: None,
                key,
                subscriber_id,
                cursor,
            },
            tick,
        ))
    }

    async fn resolve_subscription_cursor(
        &mut self,
        subscription: &RemoteSubscription,
        key: &str,
    ) -> RemoteResult<(serde_json::Value, Option<String>, RemoteTick)> {
        let Some(request) = &subscription.cursor else {
            return Ok((subscription.pull_args.clone(), None, RemoteTick::default()));
        };
        let mut tick = RemoteTick::default();
        let hosted = if let Some(cursor) = self.store.remote_cursor_read(key)? {
            cursor
        } else {
            let mut cursor = None;
            let mut resolved = None;
            for _ in 0..1_024 {
                let args = pull::cursor_args(
                    &self.config.runtime,
                    &subscription.pull_fn,
                    &subscription.pull_args,
                    &request.path,
                    &request.boundary,
                    cursor.as_deref(),
                )?;
                let (result, queried) = self
                    .query_with_tick(protocol::pull_function()?, args)
                    .await?;
                tick.merge(queried);
                let FunctionResult::Value(value) = result else {
                    return Err(function_result_error(protocol::EMBEDDED_PULL, &result));
                };
                let page = pull::decode_cursor(value)?;
                if page.found {
                    resolved = page.cursor;
                    break;
                }
                if page.is_done || page.cursor.is_none() {
                    break;
                }
                cursor = page.cursor;
            }
            resolved.ok_or_else(|| {
                RemoteError::Protocol(
                    "EMBEDDED_CURSOR_RESOLUTION: hosted boundary was not found".to_owned(),
                )
            })?
        };
        let mut args = subscription.pull_args.clone();
        json_pointer_write(
            &mut args,
            &request.path,
            serde_json::Value::String(hosted.clone()),
        )?;
        Ok((args, Some(hosted), tick))
    }

    fn pull_changed_results(
        &self,
        pending_keys: &BTreeSet<String>,
    ) -> Vec<(String, FunctionResult)> {
        self.pull_subscriptions
            .iter()
            .filter(|subscription| !pending_keys.contains(&subscription.key))
            .filter_map(|subscription| {
                self.base
                    .latest_results()
                    .get(&subscription.subscriber_id)
                    .filter(|result| {
                        self.observed_remote_result(&subscription.key) != Some(*result)
                    })
                    .cloned()
                    .map(|result| (subscription.key.clone(), result))
            })
            .collect()
    }

    fn pull_subscriptions_clear(&mut self) {
        for subscription in self.pull_subscriptions.drain(..) {
            self.base.unsubscribe(subscription.subscriber_id);
        }
    }

    fn has_pending_push(&self) -> bool {
        !self.inflight_remote_push.is_empty()
            || !self.push_queue_empty
            || !self.pending_checkpoints.is_empty()
    }

    async fn acknowledge_settlements(&mut self) -> RemoteResult<RemoteTick> {
        let mut tick = RemoteTick::default();
        if self.receipt_queue_empty {
            return Ok(tick);
        }
        let replay_ids = self.store.remote_receipt_read(REMOTE_RECEIPT_LIMIT)?;
        if replay_ids.is_empty() {
            self.receipt_queue_empty = true;
            return Ok(tick);
        }
        let request = BTreeMap::from([
            ("kind".to_owned(), Value::String("acknowledge".to_owned())),
            (
                "clientId".to_owned(),
                Value::String(self.config.client_id.as_str().to_owned()),
            ),
            (
                "replayId".to_owned(),
                Value::String(
                    replay_ids
                        .last()
                        .expect("a non-empty acknowledgment batch has a final mutation")
                        .clone(),
                ),
            ),
        ]);
        let args = ConvexArgs::from([("request".to_owned(), Value::Object(request))]);
        let (result, remote_tick) = match self
            .mutation_with_tick(protocol::push_function()?, args)
            .await
        {
            Ok(pair) => pair,
            Err(error @ (RemoteError::Retired(_) | RemoteError::DeploymentMismatch(_))) => {
                return Err(error);
            }
            Err(_) => return Ok(tick),
        };
        tick.merge(remote_tick);
        if matches!(result, FunctionResult::Value(Value::Null)) {
            self.store.remote_receipt_delete(&replay_ids)?;
            tick.receipts_pushed += replay_ids.len();
            self.receipt_queue_empty = replay_ids.len() < REMOTE_RECEIPT_LIMIT;
        } else if let error @ (RemoteError::Retired(_) | RemoteError::DeploymentMismatch(_)) =
            function_result_error(protocol::EMBEDDED_PUSH, &result)
        {
            return Err(error);
        }
        Ok(tick)
    }

    async fn wait_for_query_result(
        &mut self,
        subscriber_id: convex::base_client::SubscriberId,
        deadline: u64,
    ) -> RemoteResult<FunctionResult> {
        self.wait_for_query_result_with_tick(subscriber_id, deadline)
            .await
            .map(|(result, _)| result)
    }

    async fn wait_for_query_result_with_tick(
        &mut self,
        subscriber_id: convex::base_client::SubscriberId,
        deadline: u64,
    ) -> RemoteResult<(FunctionResult, RemoteTick)> {
        let mut tick = RemoteTick::default();
        loop {
            if let Some(result) = self.base.latest_results().get(&subscriber_id) {
                return Ok((result.clone(), tick));
            }
            self.ensure_before(deadline, "query")?;
            tick.merge(self.receive_once_before(deadline, "query").await?);
        }
    }

    async fn drain_uploads(&mut self) -> RemoteResult<RemoteTick> {
        let mut tick = RemoteTick::default();
        if !self.store.upload_has_pending()? {
            return Ok(tick);
        }
        let owner = self.upload_owner();
        for _ in 0..UPLOAD_DRAIN_LIMIT {
            let now_ms = self.clock.now_ms()?;
            let lease_until_ms =
                now_ms.saturating_add(duration_millis_i64(self.config.timing.operation_timeout));
            let Some(upload) = self.store.upload_lease_write(UploadLeaseWrite::Claimed {
                local_storage_id: None,
                owner: owner.clone(),
                now_ms,
                lease_until: lease_until_ms,
            })?
            else {
                break;
            };
            if let Some(storage_id) = self.mapped_storage_id(&upload.local_storage_id)? {
                let completed = self.store.upload_complete(
                    &upload.local_storage_id,
                    &owner,
                    &storage_id,
                    self.clock.now_ms()?,
                )?;
                if !completed {
                    return Err(RemoteError::Protocol(format!(
                        "mapped upload {} could not be completed",
                        upload.local_storage_id
                    )));
                }
                continue;
            }
            match self.upload_claimed(&upload).await {
                Ok((storage_id, upload_tick)) => {
                    tick.merge(upload_tick);
                    let completed = self.store.upload_complete(
                        &upload.local_storage_id,
                        &owner,
                        &storage_id,
                        self.clock.now_ms()?,
                    )?;
                    if !completed {
                        return Err(RemoteError::Protocol(format!(
                            "claimed upload {} could not be completed",
                            upload.local_storage_id
                        )));
                    }
                }
                Err(error) => {
                    let pending = self.store.upload_lease_write(UploadLeaseWrite::Pending {
                        local_storage_id: upload.local_storage_id.clone(),
                        owner: owner.clone(),
                        now_ms: self.clock.now_ms()?,
                    });
                    if let Err(pending_error) = pending {
                        return Err(RemoteError::Storage(pending_error));
                    }
                    return Err(error);
                }
            }
        }
        Ok(tick)
    }

    fn mapped_storage_id(&self, local_storage_id: &str) -> RemoteResult<Option<String>> {
        let Some(mapping) = self.store.id_read("_storage", local_storage_id)? else {
            return Ok(None);
        };
        Ok(match mapping.mapping {
            IdMappingContent::Mapped { convex_id } => Some(convex_id),
            IdMappingContent::Local | IdMappingContent::Deleted { .. } => None,
        })
    }

    async fn upload_claimed(
        &mut self,
        upload: &PendingUpload,
    ) -> RemoteResult<(String, RemoteTick)> {
        let bytes = self
            .store
            .blob_read(&upload.local_storage_id)?
            .ok_or_else(|| {
                RemoteError::Protocol(format!(
                    "pending upload {} is missing local blob bytes",
                    upload.local_storage_id
                ))
            })?;
        let size = i64::try_from(bytes.len()).map_err(|_| {
            RemoteError::Protocol(format!(
                "pending upload {} is too large to size as i64",
                upload.local_storage_id
            ))
        })?;
        if size != upload.size {
            return Err(RemoteError::Protocol(format!(
                "pending upload {} size mismatch: queue={}, blob={}",
                upload.local_storage_id, upload.size, size
            )));
        }
        let sha256 = sha256_hex(&bytes);
        if sha256 != upload.sha256 {
            return Err(RemoteError::Protocol(format!(
                "pending upload {} sha256 mismatch",
                upload.local_storage_id
            )));
        }
        let (result, result_tick) = self
            .mutation_with_tick(protocol::upload_function()?, upload::args(upload))
            .await?;
        let FunctionResult::Value(value) = result else {
            return Err(function_result_error(protocol::EMBEDDED_UPLOAD, &result));
        };
        let upload_url = upload::decode_upload_url(value)?;
        let owner = self.upload_owner();
        self.upload_lease_write(upload, &owner)?;
        let receipt = self
            .uploader
            .upload(RemoteUploadRequest {
                bytes,
                content_type: upload.content_type.clone(),
                local_storage_id: upload.local_storage_id.clone(),
                sha256: upload.sha256.clone(),
                size: upload.size,
                upload_url,
            })
            .await?;
        if receipt.storage_id.is_empty() {
            return Err(RemoteError::Protocol(
                "upload response returned empty storageId".to_owned(),
            ));
        }
        self.upload_lease_write(upload, &owner)?;
        Ok((receipt.storage_id, result_tick))
    }

    fn upload_lease_write(&self, upload: &PendingUpload, owner: &str) -> RemoteResult<()> {
        let now_ms = self.clock.now_ms()?;
        let lease_until_ms =
            now_ms.saturating_add(duration_millis_i64(self.config.timing.operation_timeout));
        let claimed = self.store.upload_lease_write(UploadLeaseWrite::Claimed {
            local_storage_id: Some(upload.local_storage_id.clone()),
            owner: owner.to_owned(),
            now_ms,
            lease_until: lease_until_ms,
        })?;
        if claimed.is_some() {
            Ok(())
        } else {
            Err(RemoteError::Protocol(format!(
                "claimed upload {} lost its lease",
                upload.local_storage_id
            )))
        }
    }

    fn upload_owner(&self) -> String {
        format!("remote:{}", self.config.author_client_id.as_str())
    }

    /// Submit the dependency-ready durable replay prefix to Convex's ordered mutation queue.
    pub async fn doc_push(
        &mut self,
        _table: &str,
        _local_document_id: &str,
        _token: DirtyHeadToken,
    ) -> RemoteResult<RemoteDocPush> {
        let mut tick = RemoteTick::default();
        self.push_queue_empty = false;
        // A browser pull may yield to this foreground request immediately after consuming the
        // rebase settlement, before it queues the changed subscription result. Reconcile that
        // deferred result here. Otherwise every later pull can observe only a transport timeout
        // while `replay_waiting_for_remote_write` permanently rejects the retained envelope.
        if self.replay_waiting_for_remote_write {
            tick.merge(self.queue_changed_subscription_results().await?);
            tick.merge(self.drive_remote_write_with_ingress().await?);
        }
        if self.replay_waiting_for_remote_write {
            self.pending_write(&mut tick)?;
            return Ok(RemoteDocPush {
                state: RemoteDocPushState::Blocked,
                tick,
            });
        }
        tick.merge(self.finish_active_remote_write_before_replay().await?);
        tick.merge(self.dispatch_ready_remote_pushes().await?);
        self.pending_write(&mut tick)?;
        Ok(RemoteDocPush {
            state: self.push_queue_state()?,
            tick,
        })
    }

    async fn dispatch_ready_remote_pushes(&mut self) -> RemoteResult<RemoteTick> {
        let mut tick = RemoteTick::default();
        if self.replay_waiting_for_remote_write
            || self.replay_inflight_discarding
            || (self.replay_inflight_invalidated && !self.inflight_remote_push.is_empty())
            || self.push_queue_empty
        {
            return Ok(tick);
        }
        let mut queued = self
            .store
            .remote_push_envelope_read(REPLAY_INFLIGHT_LIMIT)?
            .into_iter()
            .map(|json| push::decode_envelope(&json))
            .collect::<RemoteResult<Vec<_>>>()?;
        let inflight_envelopes = self
            .inflight_remote_push
            .iter()
            .filter_map(|inflight| match &inflight.kind {
                InflightRemotePushKind::Mutation { envelope, .. } => {
                    Some((envelope.mutation_id.clone(), envelope.commit_seq))
                }
                InflightRemotePushKind::Blob | InflightRemotePushKind::Checkpoint { .. } => None,
            })
            .collect::<Vec<_>>();
        if inflight_envelopes.len() >= REPLAY_INFLIGHT_LIMIT {
            return Ok(tick);
        }
        for (queued, (mutation_id, commit_seq)) in queued.iter().zip(&inflight_envelopes) {
            if queued.mutation_id != *mutation_id || queued.commit_seq != *commit_seq {
                // A local commit can make the durable prefix change while an older window is
                // already hosted (for example, a legacy store whose commit-sequence cache was
                // seeded below a retained push envelope). Keep every durable envelope, drain the
                // original receivers without adopting their out-of-order results, then replay the
                // stable durable order. Their persisted replay IDs make any hosted success return
                // the same cached settlement rather than execute twice.
                self.replay_inflight_discarding = true;
                self.replay_inflight_invalidated = false;
                return Ok(tick);
            }
        }
        if queued.len() <= inflight_envelopes.len() {
            self.push_queue_empty = queued.is_empty();
            return Ok(tick);
        }

        let capacity = REPLAY_INFLIGHT_LIMIT - inflight_envelopes.len();
        for envelope in queued
            .iter_mut()
            .skip(inflight_envelopes.len())
            .take(capacity)
        {
            self.prepare_transport_runtime(envelope)?;
        }
        let mut prefixes = self.speculative_crdt_prefixes()?;
        let mut acknowledgements = self.store.remote_receipt_read(REMOTE_RECEIPT_LIMIT)?;
        tick.sent += self.ensure_connected().await?;
        for mut envelope in queued
            .into_iter()
            .skip(inflight_envelopes.len())
            .take(capacity)
        {
            if !self.prepare_pending_envelope(&mut envelope, &mut prefixes)? {
                break;
            }
            for checkpoint in envelope
                .crdt
                .iter()
                .filter_map(|effect| effect.checkpoint.as_ref())
            {
                tick.push_attempted += self.stage_blob(&checkpoint.bytes, &checkpoint.hash)?;
            }
            let carried_acknowledgements = std::mem::take(&mut acknowledgements);
            let args = push::mutation_args(
                &envelope,
                self.config.author_client_id.as_str(),
                carried_acknowledgements.last().map(String::as_str),
            )?;
            let result = self
                .base
                .mutation(protocol::push_function()?.into_udf_path(), args);
            self.inflight_remote_push.push_back(InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: carried_acknowledgements,
                    envelope: Box::new(envelope),
                },
                result,
            });
            tick.push_attempted += 1;
        }
        tick.sent += self.flush_outbound().await?;
        self.push_queue_empty = self.store.remote_push_envelope_read(1)?.is_empty();
        Ok(tick)
    }

    fn prepare_transport_runtime(&self, envelope: &mut PushEnvelope) -> RemoteResult<()> {
        let queued = &envelope.runtime;
        let current = &self.config.runtime;
        if queued == current {
            return Ok(());
        }
        if queued.protocol_version > current.protocol_version {
            return Err(RemoteError::DeploymentMismatch(format!(
                "queued mutation {} requires newer embedded protocol {} (this app uses {}); local data was preserved, so update the app before replaying it",
                envelope.mutation_id, queued.protocol_version, current.protocol_version
            )));
        }
        if queued.schema_hash != current.schema_hash
            || !self.config.compatible_prior_runtimes.contains(queued)
        {
            return Err(RemoteError::DeploymentMismatch(format!(
                "queued mutation {} uses embedded protocol {} with schemaHash={} and moduleGraphHash={}, but this app uses protocol {} with schemaHash={} and moduleGraphHash={} and did not declare that exact prior runtime compatible; local data was preserved and the legacy envelope was not upgraded—rebuild with explicit compatible-prior-runtime migration metadata before replaying it",
                envelope.mutation_id,
                queued.protocol_version,
                queued.schema_hash,
                queued.module_graph_hash,
                current.protocol_version,
                current.schema_hash,
                current.module_graph_hash
            )));
        }

        // This is a transport-only compatibility projection. The exact prior identity was
        // declared compatible by the current build. The durable envelope keeps the identity under
        // which its logical mutation was authored; mutation and replay fingerprints remain stable.
        envelope.runtime = current.clone();
        Ok(())
    }

    fn speculative_crdt_prefixes(
        &self,
    ) -> RemoteResult<BTreeMap<(String, String, String), SpeculativeCrdtPrefix>> {
        let mut prefixes = BTreeMap::new();
        for inflight in &self.inflight_remote_push {
            let InflightRemotePushKind::Mutation { envelope, .. } = &inflight.kind else {
                continue;
            };
            for effect in &envelope.crdt {
                let local_id = self.local_id_of(&effect.table, &effect.row_id)?;
                let key = (effect.table.clone(), local_id.clone(), effect.field.clone());
                if !prefixes.contains_key(&key) {
                    prefixes.insert(
                        key.clone(),
                        self.speculative_crdt_prefix_read(&effect.table, &local_id, &effect.field)?,
                    );
                }
                let prefix = prefixes.get_mut(&key).expect("prefix was inserted");
                if effect.base_seq != prefix.head_seq {
                    return Err(RemoteError::Protocol(
                        "inflight CRDT effects do not form a contiguous prefix".to_owned(),
                    ));
                }
                prefix.head_seq += 1;
                effect
                    .projection_hash
                    .clone_into(&mut prefix.projection_hash);
                prefix.payloads.push(effect.payload.clone());
            }
        }
        Ok(prefixes)
    }

    fn speculative_crdt_prefix_read(
        &self,
        table: &str,
        local_id: &str,
        field: &str,
    ) -> RemoteResult<SpeculativeCrdtPrefix> {
        let state = self
            .store
            .crdt_read_states(table, local_id)?
            .into_iter()
            .find(|state| state.field == field)
            .ok_or_else(|| {
                RemoteError::Protocol(format!(
                    "queued CRDT effect targets missing field {table}.{field}:{local_id}"
                ))
            })?;
        Ok(SpeculativeCrdtPrefix {
            epoch: state.epoch,
            head_seq: state.head_seq,
            payloads: Vec::new(),
            projection_hash: state.projection_hash,
        })
    }

    fn prepare_pending_envelope(
        &self,
        envelope: &mut PushEnvelope,
        prefixes: &mut BTreeMap<(String, String, String), SpeculativeCrdtPrefix>,
    ) -> RemoteResult<bool> {
        if !self.map_id_paths_to_hosted(&mut envelope.args, &envelope.id_paths)? {
            return Ok(false);
        }
        for base in &mut envelope.read_set {
            match base {
                storage::BaseVersion::Point {
                    table,
                    id,
                    version,
                    content_hash,
                    crdt,
                } => {
                    let local_id = self.local_id_of(table, id)?;
                    if let Some(projection) = self.store.remote_doc_read(table, &local_id)? {
                        if projection.server_base.as_deref() == Some(content_hash.as_str())
                            && projection.logical_clock.is_finite()
                            && projection.logical_clock > *version
                        {
                            *version = projection.logical_clock;
                        }
                    }
                    for state in self.store.crdt_read_states(table, &local_id)? {
                        if state.projection_hash.is_empty() {
                            continue;
                        }
                        if let Some(witness) =
                            crdt.iter_mut().find(|witness| witness.field == state.field)
                        {
                            witness.epoch = state.epoch;
                            witness.head_seq = state.head_seq;
                            witness.projection_hash = state.projection_hash;
                        }
                    }
                    for witness in crdt {
                        if let Some(prefix) =
                            prefixes.get(&(table.clone(), local_id.clone(), witness.field.clone()))
                        {
                            witness.epoch = prefix.epoch;
                            witness.head_seq = prefix.head_seq;
                            prefix
                                .projection_hash
                                .clone_into(&mut witness.projection_hash);
                        }
                    }
                    if let Some(hosted) = self.hosted_id_of(&local_id)? {
                        *id = hosted;
                    }
                }
                storage::BaseVersion::Range(range) => {
                    for member in &mut range.members {
                        if let Some(hosted) = self.hosted_id_of(member)? {
                            *member = hosted;
                        } else if is_unresolved_local_id(member) {
                            return Ok(false);
                        }
                    }
                    if range.members.len() != range.member_hashes.len() {
                        return Err(RemoteError::Protocol(
                            "range witness member hashes are incomplete".to_owned(),
                        ));
                    }
                    let digest = range
                        .members
                        .iter()
                        .zip(range.member_hashes.iter())
                        .map(|(id, hash)| serde_json::json!({ "id": id, "hash": hash }))
                        .collect::<Vec<_>>();
                    range.members_hash = sha256_json(&digest)?;
                }
            }
        }
        self.prepare_crdt_effects(&mut envelope.crdt, prefixes)?;
        for checkpoint in &mut envelope.revision_checkpoints {
            let snapshots = self
                .store
                .crdt_snapshot_read(&checkpoint.table, &checkpoint.row_id)?;
            if !snapshots.is_empty() {
                checkpoint.snapshots = snapshots;
            }
        }
        let mut after_images = Vec::with_capacity(envelope.after_images.len());
        for mut candidate in envelope.after_images.drain(..) {
            if let Some(hosted) = self.hosted_id_of(&candidate.row_id)? {
                candidate.row_id = hosted;
            } else if is_unresolved_local_id(&candidate.row_id) {
                continue;
            }
            after_images.push(candidate);
        }
        envelope.after_images = after_images;
        Ok(true)
    }

    fn prepare_crdt_effects(
        &self,
        effects: &mut [storage::CrdtEffect],
        prefixes: &mut BTreeMap<(String, String, String), SpeculativeCrdtPrefix>,
    ) -> RemoteResult<()> {
        for effect in effects {
            let local_id = self.local_id_of(&effect.table, &effect.row_id)?;
            let key = (effect.table.clone(), local_id.clone(), effect.field.clone());
            if !prefixes.contains_key(&key) {
                prefixes.insert(
                    key.clone(),
                    self.speculative_crdt_prefix_read(&effect.table, &local_id, &effect.field)?,
                );
            }
            let prefix = prefixes.get_mut(&key).expect("prefix was inserted");
            let prepared = self.store.crdt_remote_effect(
                &effect.table,
                &local_id,
                &effect.field,
                effect.kind,
                &prefix.payloads,
                &effect.payload,
            )?;
            if prepared.base_seq != prefix.head_seq {
                return Err(RemoteError::Protocol(
                    "prepared CRDT effect does not follow its speculative prefix".to_owned(),
                ));
            }
            effect.base_seq = prepared.base_seq;
            effect.projection = prepared.projection;
            effect.projection_hash = sha256_value(&effect.projection)?;
            effect.checkpoint = prepared.checkpoint;
            prefix.head_seq += 1;
            effect
                .projection_hash
                .clone_into(&mut prefix.projection_hash);
            prefix.payloads.push(effect.payload.clone());
            if let Some(hosted) = self.hosted_id_of(&local_id)? {
                effect.row_id = hosted;
            }
        }
        Ok(())
    }

    fn read_queued_envelope(&self) -> RemoteResult<Option<PushEnvelope>> {
        self.store
            .remote_push_envelope_read(1)?
            .into_iter()
            .next()
            .map(|json| push::decode_envelope(&json))
            .transpose()
    }

    fn map_id_paths_to_hosted(
        &self,
        args: &mut serde_json::Value,
        paths: &[String],
    ) -> RemoteResult<bool> {
        for path in paths {
            let value = args.pointer_mut(path).ok_or_else(|| {
                RemoteError::Protocol(format!(
                    "validator-derived argument path is missing: {path}"
                ))
            })?;
            let text = value.as_str().ok_or_else(|| {
                RemoteError::Protocol(format!("validator-derived ID path is not a string: {path}"))
            })?;
            if let Some(hosted) = self.hosted_id_of(text)? {
                *value = serde_json::Value::String(hosted);
            } else if is_unresolved_local_id(text) {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// The hosted id a local `table|suffix` id maps to, or `None` when the string
    /// is not an id-map entry (fresh insert, opaque scalar, non-id text).
    fn hosted_id_of(&self, text: &str) -> RemoteResult<Option<String>> {
        let Some((table, suffix)) = text.split_once('|') else {
            return Ok(None);
        };
        if suffix.is_empty() || !is_local_id_table(table) {
            return Ok(None);
        }
        Ok(self
            .store
            .id_read(table, text)?
            .and_then(|mapping| mapping.convex_id().map(str::to_owned)))
    }

    fn local_id_of(&self, table: &str, text: &str) -> RemoteResult<String> {
        Ok(self
            .store
            .id_local_read(table, text)?
            .unwrap_or_else(|| text.to_owned()))
    }

    fn push_queue_state(&mut self) -> RemoteResult<RemoteDocPushState> {
        self.push_queue_empty = self.store.remote_push_envelope_read(1)?.is_empty();
        Ok(if self.push_queue_empty {
            RemoteDocPushState::Settled
        } else {
            RemoteDocPushState::Blocked
        })
    }

    async fn push_after_remote_write_interruptible<F>(
        &mut self,
        should_yield: &mut F,
    ) -> RemoteResult<RemoteTick>
    where
        F: FnMut() -> bool,
    {
        let mut tick = RemoteTick::default();
        if self.replay_waiting_for_remote_write {
            return Ok(tick);
        }
        tick.merge(self.finish_active_remote_write_before_replay().await?);
        tick.merge(self.remote_settlement_write()?);
        tick.merge(self.dispatch_ready_remote_pushes().await?);
        if self.store.remote_push_envelope_read(1)?.is_empty()
            && self.inflight_remote_push.is_empty()
        {
            tick.merge(
                self.push_checkpoint_interruptible(&mut RemoteTick::default(), should_yield)
                    .await?,
            );
        }
        Ok(tick)
    }

    async fn push_checkpoint_interruptible<F>(
        &mut self,
        tick: &mut RemoteTick,
        _should_yield: &mut F,
    ) -> RemoteResult<RemoteTick>
    where
        F: FnMut() -> bool,
    {
        let Some(checkpoint) = self.pending_checkpoints.front().cloned() else {
            return Ok(std::mem::take(tick));
        };
        tick.sent += self.ensure_connected().await?;
        tick.push_attempted +=
            self.stage_blob(&checkpoint.checkpoint.bytes, &checkpoint.checkpoint.hash)?;
        let args = push::checkpoint_args(
            self.config.author_client_id.as_str(),
            &self.config.runtime,
            &checkpoint.request,
            &checkpoint.checkpoint,
        );
        let result = self
            .base
            .mutation(protocol::push_function()?.into_udf_path(), args);
        tick.push_attempted += 1;
        self.inflight_remote_push.push_back(InflightRemotePush {
            kind: InflightRemotePushKind::Checkpoint {
                checkpoint_id: checkpoint.request.checkpoint_id,
            },
            result,
        });
        tick.sent += self.flush_outbound().await?;
        Ok(std::mem::take(tick))
    }

    fn stage_blob(&mut self, bytes: &[u8], hash: &str) -> RemoteResult<usize> {
        if bytes.len() <= push::BLOB_CHUNK_BYTES {
            return Ok(0);
        }
        let chunks = bytes.len().div_ceil(push::BLOB_CHUNK_BYTES);
        for ordinal in 0..chunks {
            let args = push::blob_args(
                self.config.author_client_id.as_str(),
                &self.config.runtime,
                bytes,
                hash,
                ordinal,
            );
            let result = self
                .base
                .mutation(protocol::push_function()?.into_udf_path(), args);
            self.inflight_remote_push.push_back(InflightRemotePush {
                kind: InflightRemotePushKind::Blob,
                result,
            });
        }
        Ok(chunks)
    }

    /// Adopt the server re-run verdict (§2/§11 D2): bind each inserted local id to its hosted id,
    /// count conflicts, and drain the settled envelope from the durable queue by `op_id`. LWW is
    /// demoted to pull-adoption order (e1 §8) — the server verdict is authoritative here, and the
    /// pull response delivers the authoritative rows the client converges on.
    #[allow(
        clippy::too_many_lines,
        reason = "one server verdict must settle IDs, schedules, uploads, revisions, and the envelope atomically"
    )]
    fn complete_remote_push(
        &mut self,
        envelope: &PushEnvelope,
        result: &FunctionResult,
        result_tick: RemoteTick,
    ) -> RemoteResult<(RemoteTick, PushOutcome)> {
        let mut tick = RemoteTick::default();
        let response = mutation_push_response(envelope, result)?;
        let queued = self.read_queued_envelope()?.ok_or_else(|| {
            RemoteError::Protocol("remote push settlement lost its queued envelope".to_owned())
        })?;
        if queued.mutation_id != envelope.mutation_id || queued.commit_seq != envelope.commit_seq {
            return Err(RemoteError::Protocol(
                "remote push settlement is not at the durable queue front".to_owned(),
            ));
        }
        if response.mutation_id != envelope.mutation_id {
            return Err(RemoteError::Protocol(
                "remote push settlement mutation ID does not match its queued envelope".to_owned(),
            ));
        }
        let ids = validate_insert_settlement(&queued, &response)?;
        let schedules = validate_schedule_settlement(&queued, &response)?
            .into_iter()
            .map(|(local_id, server_id)| storage::RemoteScheduleMapping {
                local_id,
                server_id,
            })
            .collect();
        validate_upload_settlement(&queued, &response)?;
        let revisions = self.validate_revision_settlement(&queued, &response)?;
        let now = self.clock.now_ms()?;
        if response.outcome == PushOutcome::Rebase {
            tick.push_rebases += 1;
            self.wait_for_rebase_remote_write();
            tick.merge(result_tick);
            return Ok((tick, response.outcome));
        }
        let projections = self.authoritative_projections(&queued, &response, now)?;
        let crdt = if response.outcome == PushOutcome::Applied {
            if response.crdt.len() != envelope.crdt.len()
                || envelope.crdt.len() != queued.crdt.len()
            {
                return Err(RemoteError::Protocol(
                    "applied settlement CRDT acknowledgements do not match the envelope".to_owned(),
                ));
            }
            response
                .crdt
                .iter()
                .zip(&envelope.crdt)
                .zip(&queued.crdt)
                .map(|((settled, prepared), local)| {
                    if prepared.table != local.table
                        || prepared.field != local.field
                        || prepared.kind != local.kind
                        || prepared.payload != local.payload
                        || settled.table != prepared.table
                        || settled.row_id != prepared.row_id
                        || settled.field != prepared.field
                        || settled.kind != prepared.kind
                        || settled.projection_hash != prepared.projection_hash
                    {
                        return Err(RemoteError::Protocol(
                            "applied settlement CRDT acknowledgement changed identity".to_owned(),
                        ));
                    }
                    if settled.head_seq == prepared.base_seq {
                        // A delayed idempotent replay may arrive after pull already observed the
                        // accepted CRDT head. Consume the durable mutation without writing the
                        // same payload at a fictitious next sequence.
                        return Ok(None);
                    }
                    if settled.head_seq != prepared.base_seq + 1 {
                        return Err(RemoteError::Protocol(
                            "applied settlement CRDT acknowledgement changed identity".to_owned(),
                        ));
                    }
                    Ok(Some(storage::CrdtRemoteWrite {
                        table: local.table.clone(),
                        id: local.row_id.clone(),
                        field: local.field.clone(),
                        kind: local.kind,
                        head_seq: settled.head_seq,
                        projection_hash: settled.projection_hash.clone(),
                        payload: prepared.payload.clone(),
                    }))
                })
                .collect::<RemoteResult<Vec<_>>>()?
                .into_iter()
                .flatten()
                .collect()
        } else {
            if !response.crdt.is_empty() {
                return Err(RemoteError::Protocol(
                    "non-applied settlement carried CRDT acknowledgements".to_owned(),
                ));
            }
            Vec::new()
        };
        let outcome = match response.outcome {
            PushOutcome::Applied => storage::RemoteSettlementOutcome::Applied {
                ids,
                schedules,
                projections,
                crdt,
            },
            PushOutcome::Conflict | PushOutcome::Rejected => {
                storage::RemoteSettlementOutcome::Rejected {
                    schedules: queued.local_schedule_ids.clone(),
                    targets: rejected_write_targets(&queued)
                        .into_iter()
                        .map(|(table, local_document_id)| {
                            let key = (table.clone(), local_document_id.clone());
                            let server_rev_id = revisions.get(&key).cloned();
                            storage::RemoteRowTarget {
                                retain: rejected_target_should_retain(
                                    &queued,
                                    &revisions,
                                    &key,
                                    matches!(&response.outcome, PushOutcome::Rejected),
                                ),
                                server_rev_id,
                                table,
                                local_document_id,
                            }
                        })
                        .collect(),
                    projections,
                }
            }
            PushOutcome::Rebase => {
                unreachable!("rebase settlements return before local settlement")
            }
        };
        let settled = self
            .store
            .remote_settlement_write(&storage::RemoteSettlementWrite {
                mutation_id: envelope.mutation_id.clone(),
                expected_commit_seq: envelope.commit_seq,
                now_ms: now,
                outcome,
            })?;
        tick.rows_applied += settled.projection.committed.len();
        for commit in settled.projection.committed {
            for table in commit.changed_tables {
                if !tick.changed_tables.contains(&table) {
                    tick.changed_tables.push(table);
                }
            }
        }
        match response.outcome {
            PushOutcome::Applied => {
                tick.push_accepted += 1;
                tick.pushed += 1;
            }
            PushOutcome::Conflict => tick.push_conflicts += 1,
            PushOutcome::Rejected => tick.push_failed += 1,
            PushOutcome::Rebase => unreachable!("rebase returned before settlement"),
        }
        tick.retained_revisions.extend(settled.projection.reroots);
        self.receipt_queue_empty = false;
        tick.merge(result_tick);
        Ok((tick, response.outcome))
    }

    fn wait_for_rebase_remote_write(&mut self) {
        self.replay_waiting_for_remote_write = true;
    }

    fn complete_checkpoint_push(
        &mut self,
        checkpoint_id: &str,
        result: &FunctionResult,
        mut tick: RemoteTick,
    ) -> RemoteResult<RemoteTick> {
        let FunctionResult::Value(Value::Null) = result else {
            return Err(function_result_error(protocol::EMBEDDED_PUSH, result));
        };
        let checkpoint = self.pending_checkpoints.pop_front().ok_or_else(|| {
            RemoteError::Protocol("checkpoint push completed without a pending request".to_owned())
        })?;
        if checkpoint.request.checkpoint_id != checkpoint_id {
            return Err(RemoteError::Protocol(
                "checkpoint push completed out of causal order".to_owned(),
            ));
        }
        tick.pushed += 1;
        Ok(tick)
    }

    fn authoritative_projections(
        &self,
        envelope: &PushEnvelope,
        response: &storage::PushResponse,
        now_ms: i64,
    ) -> RemoteResult<Vec<AuthoritativeRow>> {
        response
            .authoritative
            .iter()
            .map(|change| {
                let (table, server_id, fields, plain_hash) = match change {
                    storage::AuthoritativeChange::Put {
                        table,
                        row_id,
                        fields,
                        plain_hash,
                    } => (table, row_id, Some(fields), plain_hash),
                    storage::AuthoritativeChange::Delete {
                        table,
                        row_id,
                        plain_hash,
                    } => (table, row_id, None, plain_hash),
                };
                let local_id =
                    self.local_id_for_authoritative(envelope, response, table, server_id)?;
                let row = fields
                    .map(serde_json::to_string)
                    .transpose()
                    .map_err(|error| {
                        RemoteError::Protocol(format!(
                            "authoritative row JSON encode failed: {error}"
                        ))
                    })?;
                Ok(AuthoritativeRow {
                    table: table.clone(),
                    local_document_id: Some(local_id),
                    plain_hash: plain_hash.clone(),
                    server_document_id: server_id.clone(),
                    projection_hash: sha256_value(fields.unwrap_or(&serde_json::Value::Null))?,
                    current_root_id: None,
                    current_node_id: None,
                    row,
                    logical_clock: None,
                    received_time: now_ms,
                })
            })
            .collect()
    }

    fn local_id_for_authoritative(
        &self,
        envelope: &PushEnvelope,
        response: &storage::PushResponse,
        table: &str,
        server_id: &str,
    ) -> RemoteResult<String> {
        if let Some(insert) = response
            .inserts
            .iter()
            .find(|insert| insert.table == table && insert.id == server_id)
        {
            return envelope
                .id_allocations
                .get(insert.ordinal)
                .cloned()
                .ok_or_else(|| {
                    RemoteError::Protocol(
                        "authoritative insert has no matching local allocation".to_owned(),
                    )
                });
        }
        for candidate in &envelope.after_images {
            if candidate.table == table
                && self.hosted_id_of(&candidate.row_id)?.as_deref() == Some(server_id)
            {
                return Ok(candidate.row_id.clone());
            }
        }
        for witness in &envelope.read_set {
            if let storage::BaseVersion::Point {
                table: witness_table,
                id,
                ..
            } = witness
            {
                if witness_table == table && self.hosted_id_of(id)?.as_deref() == Some(server_id) {
                    return Ok(id.clone());
                }
            }
        }
        Err(RemoteError::Protocol(
            "authoritative row has no matching local address".to_owned(),
        ))
    }

    async fn enqueue_pull_result(
        &mut self,
        result: FunctionResult,
        subscription: &str,
    ) -> RemoteResult<RemoteTick> {
        if self
            .observed_remote_result(subscription)
            .is_some_and(|observed| observed == &result)
        {
            return Ok(RemoteTick::default());
        }
        if self.pull_result_already_failed(subscription, &result) {
            return Ok(RemoteTick::default());
        }
        let descriptor = self
            .scope
            .subscriptions
            .iter()
            .find(|candidate| {
                remote_subscription_key(candidate).ok().as_deref() == Some(subscription)
            })
            .cloned()
            .ok_or_else(|| {
                RemoteError::Protocol("pull result has no active descriptor".to_owned())
            })?;
        match self
            .stage_prepared_pull_result(result.clone(), subscription, &descriptor)
            .await
        {
            Ok(()) => {
                self.clear_pull_failure(subscription);
                Ok(RemoteTick::default())
            }
            Err(error) if error.is_transient() => Err(error),
            Err(error) => {
                self.record_pull_failure(subscription, result);
                Ok(RemoteTick {
                    pull_diagnostics: 1,
                    pull_error: Some(error.to_string()),
                    ..RemoteTick::default()
                })
            }
        }
    }

    async fn stage_prepared_pull_result(
        &mut self,
        result: FunctionResult,
        subscription: &str,
        descriptor: &RemoteSubscription,
    ) -> RemoteResult<()> {
        let (page, crdt, result) = self
            .prepare_pull_result(result, subscription, descriptor)
            .await?;
        let prepared = self.prepare_remote_write(&page, crdt, result, subscription)?;
        self.stage_remote_write(prepared);
        Ok(())
    }

    /// A retained result whose application already failed permanently is not re-attempted until the
    /// live manifest changes. Without this gate a checkpoint prefix the server can no longer supply
    /// (e.g. after a component wipe) re-issues a fresh one-shot pull on every tick — an unbounded hot
    /// loop with no convergence.
    fn pull_result_already_failed(&self, subscription: &str, result: &FunctionResult) -> bool {
        self.pull_subscriptions
            .iter()
            .find(|active| active.key == subscription)
            .and_then(|active| active.last_failed_result.as_ref())
            .is_some_and(|failed| failed == result)
    }

    fn record_pull_failure(&mut self, subscription: &str, result: FunctionResult) {
        if let Some(active) = self
            .pull_subscriptions
            .iter_mut()
            .find(|active| active.key == subscription)
        {
            active.last_failed_result = Some(result);
        }
    }

    fn clear_pull_failure(&mut self, subscription: &str) {
        if let Some(active) = self
            .pull_subscriptions
            .iter_mut()
            .find(|active| active.key == subscription)
        {
            active.last_failed_result = None;
        }
    }

    fn stage_remote_write(&mut self, pending: PendingRemoteWrite) {
        if !self
            .remote_write_pending
            .contains_key(&pending.subscription)
        {
            self.remote_write_order
                .push_back(pending.subscription.clone());
        }
        self.remote_write_pending
            .insert(pending.subscription.clone(), pending);
    }

    async fn prepare_pull_result(
        &mut self,
        mut result: FunctionResult,
        subscription: &str,
        descriptor: &RemoteSubscription,
    ) -> RemoteResult<(pull::PullPage, Vec<PreparedCrdt>, FunctionResult)> {
        let accepted_crdt = self.accepted_crdt(subscription)?;
        let mut stale_restarts = 0usize;
        'manifest: loop {
            let FunctionResult::Value(value) = result.clone() else {
                return Err(function_result_error(protocol::EMBEDDED_PULL, &result));
            };
            let page = pull::decode(value)?;
            let mut prepared_crdt = Vec::with_capacity(page.crdt.len());
            for crdt in &page.crdt {
                if accepted_crdt.contains(crdt) {
                    prepared_crdt.push(PreparedCrdt {
                        change: None,
                        checkpoint_response: None,
                        blob: None,
                    });
                } else {
                    match self.prepare_crdt(descriptor, crdt).await {
                        Ok(prepared) => prepared_crdt.push(prepared),
                        Err(RemoteError::StaleCheckpoint) => {
                            stale_restarts += 1;
                            if stale_restarts > 4 {
                                return Err(RemoteError::Protocol(
                                    "checkpoint manifest kept changing during bounded restart"
                                        .to_owned(),
                                ));
                            }
                            let refreshed = self
                                .refresh_stale_pull_result(subscription, descriptor, &result)
                                .await?;
                            if refreshed == result {
                                return Err(RemoteError::Protocol(
                                    "live pull returned the same stale checkpoint manifest"
                                        .to_owned(),
                                ));
                            }
                            result = refreshed;
                            continue 'manifest;
                        }
                        Err(error) => return Err(error),
                    }
                }
            }
            let latest = self
                .pull_subscriptions
                .iter()
                .find(|active| active.key == subscription)
                .and_then(|active| self.base.latest_results().get(&active.subscriber_id))
                .cloned();
            if let Some(latest) = latest.filter(|latest| latest != &result) {
                result = latest;
                continue;
            }
            return Ok((page, prepared_crdt, result));
        }
    }

    async fn refresh_stale_pull_result(
        &mut self,
        subscription: &str,
        descriptor: &RemoteSubscription,
        current: &FunctionResult,
    ) -> RemoteResult<FunctionResult> {
        let latest = self
            .pull_subscriptions
            .iter()
            .find(|active| active.key == subscription)
            .and_then(|active| self.base.latest_results().get(&active.subscriber_id))
            .cloned();
        if let Some(latest) = latest.filter(|latest| latest != current) {
            return Ok(latest);
        }
        let args = pull::live_args(
            &self.config.runtime,
            &descriptor.pull_fn,
            &descriptor.pull_args,
        )?;
        self.query(protocol::pull_function()?, args).await
    }

    fn accepted_crdt(&self, subscription: &str) -> RemoteResult<Vec<pull::PullCrdt>> {
        let Some(result) = self
            .pull_subscriptions
            .iter()
            .find(|active| active.key == subscription)
            .and_then(|active| active.last_result.as_ref())
        else {
            return Ok(Vec::new());
        };
        let FunctionResult::Value(value) = result else {
            return Err(function_result_error(protocol::EMBEDDED_PULL, result));
        };
        Ok(pull::decode(value.clone())?.crdt)
    }

    fn prepare_remote_write(
        &mut self,
        page: &pull::PullPage,
        crdt: Vec<PreparedCrdt>,
        result: FunctionResult,
        subscription: &str,
    ) -> RemoteResult<PendingRemoteWrite> {
        let accepted_changes = self.accepted_changes(subscription)?;
        let checkpoint_responses = crdt
            .iter()
            .filter_map(|prepared| prepared.checkpoint_response.clone())
            .collect::<Vec<_>>();
        let blobs = crdt
            .iter()
            .filter_map(|prepared| prepared.blob.clone())
            .collect::<Vec<_>>();
        let page_members = page
            .members
            .iter()
            .cloned()
            .map(remote_member)
            .collect::<Vec<_>>();
        let member_rows = page
            .members
            .iter()
            .map(|member| (member.table.clone(), member.id.clone()))
            .collect::<BTreeSet<_>>();
        let pulled_at = self.clock.now_ms()?;
        let mut projections = Vec::new();
        for change in &page.changes {
            let pull::PullChangeBody::Row(row) = &change.body;
            if !pull_change_has_changed(change, &accepted_changes) {
                let missing_member_projection =
                    if member_rows.contains(&(row.table.clone(), row.id.clone())) {
                        match self.store.id_local_read(&row.table, &row.id)? {
                            Some(local_id) => self.store.doc_read(&row.table, &local_id)?.is_none(),
                            None => true,
                        }
                    } else {
                        false
                    };
                if !missing_member_projection {
                    continue;
                }
            }
            projections.push(pull_projection_record(
                row.table.clone(),
                row.id.clone(),
                pull_change_hash(row),
                change.plain_hash.clone(),
                row.row.clone(),
                change.rev.clone(),
                None,
                None,
                pulled_at,
            ));
        }
        let crdt_changes = crdt
            .into_iter()
            .filter_map(|prepared| prepared.change)
            .collect::<Vec<_>>();
        let cursor = self
            .pull_subscriptions
            .iter()
            .find(|active| active.key == subscription)
            .and_then(|active| active.cursor.clone());
        let result_entry = page
            .result
            .as_ref()
            .map(|payload| self.result_entry(subscription, payload, &projections, pulled_at))
            .transpose()?;
        let pull_changes = projections.len();
        Ok(PendingRemoteWrite {
            checkpoint_responses,
            crdt_changes: crdt_changes.len(),
            pull_changes,
            result: Some(result),
            subscription: subscription.to_owned(),
            write: RemoteWrite::Page(storage::RemotePageWrite {
                subscription: subscription.to_owned(),
                members: page_members,
                projections,
                crdt: crdt_changes,
                blobs,
                cursor,
                received_time: pulled_at,
                result: result_entry.map(Box::new),
            }),
        })
    }

    /// Assemble the retained authored-result cache entry (Cut 7 §2/§3) for the writing pull page. The
    /// skeleton is the Convex-value codec with matched subtrees encoded as `null`; `paths` is the codec of `resultRows`,
    /// and `skeleton_hash` covers BOTH so a paths-only change still leaves the zero-write fast path.
    fn result_entry(
        &self,
        subscription: &str,
        payload: &pull::PullResult,
        projections: &[storage::AuthoritativeRow],
        pulled_at: i64,
    ) -> RemoteResult<storage::ResultEntry> {
        let descriptor = self
            .scope
            .subscriptions
            .iter()
            .find(|candidate| {
                remote_subscription_key(candidate).is_ok_and(|key| key == subscription)
            })
            .ok_or_else(|| {
                RemoteError::Protocol(
                    "retained result has no live subscription descriptor".to_owned(),
                )
            })?;
        let args_key =
            serde_json::to_string(&canonical_json(&descriptor.pull_args)).map_err(|error| {
                RemoteError::Protocol(format!("result args encode failed: {error}"))
            })?;
        let key = descriptor.result_cache_key.clone().ok_or_else(|| {
            RemoteError::Protocol(
                "retained result subscription is missing its TS-authoritative cache key".to_owned(),
            )
        })?;
        let skeleton = serde_json::to_vec(&canonical_json(&serde_json::Value::from(
            payload.skeleton.clone(),
        )))
        .map_err(|error| {
            RemoteError::Protocol(format!("result skeleton encode failed: {error}"))
        })?;
        let rows = serde_json::Value::Array(
            payload
                .rows
                .iter()
                .map(|row| {
                    serde_json::json!({
                        "path": row.path,
                        "table": row.table,
                        "rowId": row.row_id,
                    })
                })
                .collect(),
        );
        let paths = serde_json::to_vec(&canonical_json(&rows)).map_err(|error| {
            RemoteError::Protocol(format!("result paths encode failed: {error}"))
        })?;
        let mut digest_input = skeleton.clone();
        digest_input.extend_from_slice(&paths);
        let skeleton_hash = sha256_hex(&digest_input);
        let clock = projections
            .iter()
            .filter_map(|record| record.logical_clock)
            .filter(|value| value.is_finite())
            .fold(None, |acc, value| {
                Some(acc.map_or(value, |current: f64| current.max(value)))
            })
            .unwrap_or(pulled_at as f64);
        Ok(storage::ResultEntry {
            key,
            function: descriptor.pull_fn.clone(),
            args: args_key,
            schema_hash: self.config.runtime.schema_hash.clone(),
            module_hash: self.config.runtime.module_graph_hash.clone(),
            skeleton,
            paths,
            skeleton_hash,
            clock,
        })
    }

    fn accepted_changes(
        &self,
        subscription: &str,
    ) -> RemoteResult<BTreeMap<(String, String), pull::PullChange>> {
        let Some(result) = self
            .pull_subscriptions
            .iter()
            .find(|active| active.key == subscription)
            .and_then(|active| active.last_result.as_ref())
        else {
            return Ok(BTreeMap::new());
        };
        let FunctionResult::Value(value) = result else {
            return Err(function_result_error(protocol::EMBEDDED_PULL, result));
        };
        Ok(pull::decode(value.clone())?
            .changes
            .into_iter()
            .map(|change| {
                let pull::PullChangeBody::Row(row) = &change.body;
                ((row.table.clone(), row.id.clone()), change)
            })
            .collect())
    }

    fn observed_remote_result(&self, subscription: &str) -> Option<&FunctionResult> {
        self.remote_write_pending
            .get(subscription)
            .and_then(|pending| pending.result.as_ref())
            .or_else(|| {
                self.remote_write_active
                    .as_ref()
                    .filter(|active| active.pending.subscription == subscription)
                    .and_then(|active| active.pending.result.as_ref())
            })
            .or_else(|| {
                self.pull_subscriptions
                    .iter()
                    .find(|active| active.key == subscription)
                    .and_then(|active| active.last_result.as_ref())
            })
    }

    fn start_next_remote_write(&mut self) -> RemoteTick {
        let tick = RemoteTick::default();
        if self.remote_write_paused || !self.inflight_remote_push.is_empty() {
            return tick;
        }
        while self.remote_write_active.is_none() {
            let Some(subscription) = self.remote_write_order.pop_front() else {
                break;
            };
            let Some(pending) = self.remote_write_pending.remove(&subscription) else {
                continue;
            };
            let future = match &pending.write {
                RemoteWrite::Page(pull) => self.store.remote_page_write(pull.clone()),
                RemoteWrite::SubscriptionDelete { now_ms } => self
                    .store
                    .remote_subscription_delete_queue(subscription, *now_ms),
            };
            self.remote_write_active = Some(ActiveRemoteWrite { future, pending });
        }
        tick
    }

    async fn finish_active_remote_write_before_replay(&mut self) -> RemoteResult<RemoteTick> {
        if self.remote_write_active.is_none() {
            return Ok(RemoteTick::default());
        }
        self.remote_write_paused = true;
        let completed = self.drive_remote_write_with_ingress().await;
        self.remote_write_paused = false;
        completed
    }

    fn complete_remote_write(
        &mut self,
        apply: Result<storage::RemotePageWriteResult, storage::StorageError>,
    ) -> RemoteResult<RemoteTick> {
        #[cfg(test)]
        self.actor_trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push("remote_write");
        let active = self.remote_write_active.take().ok_or_else(|| {
            RemoteError::Protocol("remote write completed without active work".to_owned())
        })?;
        let apply = apply?;
        let mut tick = RemoteTick::default();
        tick.pull_snapshots += 1;
        let crdt_rows = apply.crdt.clone();
        tick.pull_changes_applied += active.pending.pull_changes;
        tick.received += active.pending.crdt_changes;
        tick.rows_applied += apply.projection.committed.len();
        tick.retained_revisions.extend(apply.projection.reroots);
        for response in &active.pending.checkpoint_responses {
            self.checkpoint_enqueue(response.clone());
        }
        for commit in &apply.projection.committed {
            for table in &commit.changed_tables {
                if !tick.changed_tables.contains(table) {
                    tick.changed_tables.push(table.clone());
                }
            }
        }
        for change in &crdt_rows {
            if !tick.changed_tables.contains(&change.table) {
                tick.changed_tables.push(change.table.clone());
            }
        }
        if let Some(key) = apply.result_changed {
            if !tick.changed_results.contains(&key) {
                tick.changed_results.push(key);
            }
        }
        tick.pushed += apply.projection_deleted;
        self.commit_remote_result(&active.pending);
        tick.merge(self.remove_retired_subscriptions()?);
        if active.pending.result.is_some() {
            self.replay_waiting_for_remote_write = false;
        }
        Ok(tick)
    }

    fn commit_remote_result(&mut self, pending: &PendingRemoteWrite) {
        let Some(result) = &pending.result else {
            return;
        };
        if let Some(active) = self
            .pull_subscriptions
            .iter_mut()
            .find(|active| active.key == pending.subscription)
        {
            active.last_result = Some(result.clone());
        }
    }

    async fn prepare_crdt(
        &mut self,
        descriptor: &RemoteSubscription,
        crdt: &pull::PullCrdt,
    ) -> RemoteResult<PreparedCrdt> {
        if let Some(payload) = &crdt.payload {
            if sha256_hex(&payload.bytes) != payload.hash {
                return Err(RemoteError::Protocol(
                    "live CRDT payload failed hash verification".to_owned(),
                ));
            }
        }
        let local = self
            .store
            .id_local_read(&crdt.table, &crdt.id)?
            .map(|local_id| {
                self.store
                    .crdt_remote_state(&crdt.table, &local_id, &crdt.field, crdt.kind)
            })
            .transpose()?
            .flatten();
        if let Some(local) = &local {
            if local.epoch > crdt.epoch
                || (local.epoch == crdt.epoch && local.head_seq > crdt.head_seq)
            {
                return Ok(PreparedCrdt {
                    change: None,
                    checkpoint_response: None,
                    blob: None,
                });
            }
            if local.epoch == crdt.epoch && local.head_seq == crdt.head_seq {
                if local.projection_hash != crdt.projection_hash {
                    return Err(RemoteError::Protocol(
                        "equal CRDT heads have different projection hashes".to_owned(),
                    ));
                }
                if crdt.checkpoint_request.is_none() {
                    return Ok(PreparedCrdt {
                        change: None,
                        checkpoint_response: None,
                        blob: None,
                    });
                }
            }
            if let Some(payload) = crdt.payload.as_ref().filter(|_| {
                local.epoch == crdt.epoch
                    && local.head_seq + 1 == crdt.head_seq
                    && crdt.checkpoint_request.is_none()
            }) {
                return Ok(PreparedCrdt {
                    change: Some(storage::RemoteCrdtChange {
                        table: crdt.table.clone(),
                        document_id: crdt.id.clone(),
                        field: crdt.field.clone(),
                        kind: crdt.kind,
                        epoch: crdt.epoch,
                        checkpoint_seq: local.head_seq,
                        head_seq: crdt.head_seq,
                        projection_hash: crdt.projection_hash.clone(),
                        checkpoint: None,
                        updates: vec![payload.bytes.clone()],
                        checkpoint_request: None,
                    }),
                    checkpoint_response: None,
                    blob: None,
                });
            }
        }

        let (checkpoint, updates, blob) = self.crdt_history(descriptor, crdt).await?;
        let checkpoint_response = checkpoint_response(crdt, &checkpoint, &updates).transpose()?;
        Ok(PreparedCrdt {
            change: Some(storage::RemoteCrdtChange {
                table: crdt.table.clone(),
                document_id: crdt.id.clone(),
                field: crdt.field.clone(),
                kind: crdt.kind,
                epoch: crdt.epoch,
                checkpoint_seq: crdt.checkpoint.seq,
                head_seq: crdt.head_seq,
                projection_hash: crdt.projection_hash.clone(),
                checkpoint: Some(checkpoint),
                updates,
                checkpoint_request: crdt.checkpoint_request.clone(),
            }),
            checkpoint_response,
            blob,
        })
    }

    async fn crdt_history(
        &mut self,
        descriptor: &RemoteSubscription,
        crdt: &pull::PullCrdt,
    ) -> RemoteResult<(Vec<u8>, Vec<Vec<u8>>, Option<storage::RemoteBlob>)> {
        let key = format!("checkpoint.{}", crdt.checkpoint.hash);
        let cached = self.store.blob_read(&key)?.filter(|bytes| {
            bytes.len() == crdt.checkpoint.bytes && sha256_hex(bytes) == crdt.checkpoint.hash
        });
        let mut bytes = cached
            .clone()
            .unwrap_or_else(|| Vec::with_capacity(crdt.checkpoint.bytes));
        let mut updates = Vec::with_capacity(
            usize::try_from(crdt.head_seq - crdt.checkpoint.seq).unwrap_or_default(),
        );
        let mut cursor = cached.as_ref().and_then(|_| {
            (crdt.checkpoint.seq < crdt.head_seq)
                .then(|| format!("payload:{}", crdt.checkpoint.seq))
        });
        if cached.is_some() && cursor.is_none() {
            return Ok((bytes, updates, None));
        }
        let mut ordinal = 0usize;
        let mut next_seq = crdt.checkpoint.seq + 1;
        let mut chunk_pages = 0usize;
        let mut payload_pages = 0usize;
        loop {
            let args = pull::checkpoint_args(
                &self.config.runtime,
                &descriptor.pull_fn,
                &descriptor.pull_args,
                &crdt.table,
                &crdt.id,
                &crdt.field,
                &crdt.checkpoint.id,
                crdt.epoch,
                crdt.head_seq,
                cursor.as_deref(),
            )?;
            let result = self.query(protocol::pull_function()?, args).await?;
            let FunctionResult::Value(value) = result else {
                return Err(function_result_error(protocol::EMBEDDED_PULL, &result));
            };
            let pull::CheckpointResult::Page(page) = pull::decode_checkpoint_page(value)? else {
                return Err(RemoteError::StaleCheckpoint);
            };
            if page.checkpoint != crdt.checkpoint {
                return Err(RemoteError::Protocol(
                    "checkpoint changed during immutable transfer".to_owned(),
                ));
            }
            if page.head_seq != crdt.head_seq
                || (!page.chunks.is_empty() && !page.payloads.is_empty())
            {
                return Err(RemoteError::Protocol(
                    "checkpoint page changed head or mixed checkpoint and payload data".to_owned(),
                ));
            }
            append_checkpoint_chunks(
                page.chunks,
                cached.is_some(),
                &mut bytes,
                &mut ordinal,
                &mut chunk_pages,
            )?;
            append_checkpoint_payloads(
                page.payloads,
                &mut updates,
                &mut next_seq,
                &mut payload_pages,
            )?;
            if page.is_done {
                if page.continue_cursor.is_some() {
                    return Err(RemoteError::Protocol(
                        "completed checkpoint pull returned a continuation cursor".to_owned(),
                    ));
                }
                break;
            }
            let next_cursor = page.continue_cursor;
            if next_cursor.is_none() || next_cursor == cursor {
                return Err(RemoteError::Protocol(
                    "incomplete checkpoint pull omitted or repeated its continuation cursor"
                        .to_owned(),
                ));
            }
            cursor = next_cursor;
        }
        if bytes.len() != crdt.checkpoint.bytes || sha256_hex(&bytes) != crdt.checkpoint.hash {
            return Err(RemoteError::Protocol(
                "assembled checkpoint does not match its manifest".to_owned(),
            ));
        }
        if next_seq != crdt.head_seq + 1 {
            return Err(RemoteError::Protocol(
                "assembled checkpoint payloads do not reach the readable head".to_owned(),
            ));
        }
        let blob = cached.is_none().then(|| storage::RemoteBlob {
            key,
            bytes: bytes.clone(),
        });
        Ok((bytes, updates, blob))
    }

    fn checkpoint_enqueue(&mut self, checkpoint: PendingCheckpoint) {
        if self
            .pending_checkpoints
            .iter()
            .any(|pending| pending.request.checkpoint_id == checkpoint.request.checkpoint_id)
        {
            return;
        }
        self.pending_checkpoints.push_back(checkpoint);
    }

    fn validate_revision_settlement(
        &self,
        envelope: &PushEnvelope,
        response: &storage::PushResponse,
    ) -> RemoteResult<BTreeMap<(String, String), String>> {
        if matches!(response.outcome, PushOutcome::Applied | PushOutcome::Rebase) {
            if !response.revisions.is_empty() {
                return Err(RemoteError::Protocol(
                    "an applied or rebase settlement cannot retain rejected revisions".to_owned(),
                ));
            }
            return Ok(BTreeMap::new());
        }

        let mut settled = BTreeMap::new();
        let mut rev_ids = BTreeSet::new();
        for receipt in &response.revisions {
            if receipt.table.is_empty() || receipt.row_id.is_empty() || receipt.rev_id.is_empty() {
                return Err(RemoteError::Protocol(
                    "retained revision receipts require a table, row ID, and rev ID".to_owned(),
                ));
            }
            if !rev_ids.insert(receipt.rev_id.clone()) {
                return Err(RemoteError::Protocol(
                    "retained revision receipts contain a duplicate rev ID".to_owned(),
                ));
            }

            let mut local_id = None;
            for candidate in &envelope.after_images {
                if candidate.table != receipt.table {
                    continue;
                }
                if self.hosted_id_of(&candidate.row_id)?.as_deref() == Some(receipt.row_id.as_str())
                {
                    local_id = Some(candidate.row_id.clone());
                    break;
                }
            }
            let local_id = local_id.ok_or_else(|| {
                RemoteError::Protocol(
                    "retained revision receipt does not address an offered after-image".to_owned(),
                )
            })?;
            if settled
                .insert((receipt.table.clone(), local_id), receipt.rev_id.clone())
                .is_some()
            {
                return Err(RemoteError::Protocol(
                    "retained revision receipts contain a duplicate row address".to_owned(),
                ));
            }
        }
        Ok(settled)
    }

    fn ensure_before(&self, deadline: u64, operation: &'static str) -> RemoteResult<()> {
        if self.clock.monotonic_ms() >= deadline {
            Err(RemoteError::Timeout(operation))
        } else {
            Ok(())
        }
    }

    fn receive_timeout_before(
        &self,
        deadline: u64,
        operation: &'static str,
    ) -> RemoteResult<Duration> {
        let remaining = deadline
            .checked_sub(self.clock.monotonic_ms())
            .ok_or(RemoteError::Timeout(operation))?;
        if remaining == 0 {
            return Err(RemoteError::Timeout(operation));
        }
        Ok(self
            .config
            .timing
            .receive_timeout
            .min(Duration::from_millis(remaining)))
    }

    fn deadline_after(&self, duration: Duration) -> u64 {
        let millis = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
        self.clock.monotonic_ms().saturating_add(millis)
    }
}

fn validate_insert_settlement(
    envelope: &PushEnvelope,
    response: &storage::PushResponse,
) -> RemoteResult<Vec<storage::RemoteIdMapping>> {
    if envelope.inserts.len() != envelope.id_allocations.len() {
        return Err(RemoteError::Protocol(
            "queued push insert declarations do not match its local ID allocations".to_owned(),
        ));
    }
    for (ordinal, insert) in envelope.inserts.iter().enumerate() {
        if insert.mutation_id != envelope.mutation_id || insert.ordinal != ordinal {
            return Err(RemoteError::Protocol(
                "queued push inserts must be contiguous ordinals owned by the mutation".to_owned(),
            ));
        }
        if envelope.id_allocations[ordinal].is_empty()
            || envelope.id_allocations[..ordinal].contains(&envelope.id_allocations[ordinal])
        {
            return Err(RemoteError::Protocol(
                "queued push contains an empty or duplicate local ID allocation".to_owned(),
            ));
        }
    }
    if response.outcome != PushOutcome::Applied {
        if !response.inserts.is_empty() {
            return Err(RemoteError::Protocol(
                "a non-applied push settlement cannot contain hosted inserts".to_owned(),
            ));
        }
        return Ok(Vec::new());
    }
    if response.inserts.len() != envelope.inserts.len() {
        return Err(RemoteError::Protocol(
            "applied push settlement insert count does not match its declarations".to_owned(),
        ));
    }
    let mut mappings = Vec::with_capacity(response.inserts.len());
    for (ordinal, settled) in response.inserts.iter().enumerate() {
        let expected = &envelope.inserts[ordinal];
        if settled.ordinal != ordinal || settled.table != expected.table || settled.id.is_empty() {
            return Err(RemoteError::Protocol(
                "applied push inserts must match their declarations in ordinal order".to_owned(),
            ));
        }
        if response.inserts[..ordinal]
            .iter()
            .any(|prior| prior.table == settled.table && prior.id == settled.id)
        {
            return Err(RemoteError::Protocol(
                "applied push contains a duplicate hosted insert ID".to_owned(),
            ));
        }
        mappings.push(storage::RemoteIdMapping {
            table: settled.table.clone(),
            server_document_id: settled.id.clone(),
            local_document_id: envelope.id_allocations[ordinal].clone(),
        });
    }
    Ok(mappings)
}

fn validate_schedule_settlement(
    envelope: &PushEnvelope,
    response: &storage::PushResponse,
) -> RemoteResult<Vec<(String, String)>> {
    if envelope.schedules.len() != envelope.local_schedule_ids.len() {
        return Err(RemoteError::Protocol(
            "queued push schedule declarations do not match its local schedule IDs".to_owned(),
        ));
    }
    for (ordinal, reference) in envelope.schedules.iter().enumerate() {
        if reference.mutation_id != envelope.mutation_id || reference.ordinal != ordinal {
            return Err(RemoteError::Protocol(
                "queued push schedules must be contiguous ordinals owned by the mutation"
                    .to_owned(),
            ));
        }
        if envelope.local_schedule_ids[..ordinal].contains(&envelope.local_schedule_ids[ordinal]) {
            return Err(RemoteError::Protocol(
                "queued push contains a duplicate local schedule ID".to_owned(),
            ));
        }
    }

    if response.outcome != PushOutcome::Applied {
        if !response.schedules.is_empty() {
            return Err(RemoteError::Protocol(
                "a non-applied push settlement cannot contain hosted schedules".to_owned(),
            ));
        }
        return Ok(Vec::new());
    }
    if response.schedules.len() != envelope.schedules.len() {
        return Err(RemoteError::Protocol(
            "applied push settlement schedule count does not match its declarations".to_owned(),
        ));
    }

    let mut mappings = Vec::with_capacity(response.schedules.len());
    for (ordinal, settled) in response.schedules.iter().enumerate() {
        if settled.ordinal != ordinal {
            return Err(RemoteError::Protocol(
                "applied push schedules must be returned once in ordinal order".to_owned(),
            ));
        }
        if settled.id.is_empty()
            || response.schedules[..ordinal]
                .iter()
                .any(|prior| prior.id == settled.id)
        {
            return Err(RemoteError::Protocol(
                "applied push contains an empty or duplicate hosted schedule ID".to_owned(),
            ));
        }
        mappings.push((
            envelope.local_schedule_ids[ordinal].clone(),
            settled.id.clone(),
        ));
    }
    Ok(mappings)
}

fn validate_upload_settlement(
    envelope: &PushEnvelope,
    response: &storage::PushResponse,
) -> RemoteResult<()> {
    for (ordinal, reference) in envelope.uploads.iter().enumerate() {
        if reference.mutation_id != envelope.mutation_id || reference.ordinal != ordinal {
            return Err(RemoteError::Protocol(
                "queued push uploads must be contiguous ordinals owned by the mutation".to_owned(),
            ));
        }
    }
    if response.outcome != PushOutcome::Applied {
        if !response.uploads.is_empty() {
            return Err(RemoteError::Protocol(
                "a non-applied push settlement cannot contain hosted upload URLs".to_owned(),
            ));
        }
        return Ok(());
    }
    if response.uploads.len() != envelope.uploads.len() {
        return Err(RemoteError::Protocol(
            "applied push settlement upload count does not match its declarations".to_owned(),
        ));
    }
    for (ordinal, settled) in response.uploads.iter().enumerate() {
        if settled.ordinal != ordinal {
            return Err(RemoteError::Protocol(
                "applied push uploads must be returned once in ordinal order".to_owned(),
            ));
        }
        if settled.url.is_empty()
            || response.uploads[..ordinal]
                .iter()
                .any(|prior| prior.url == settled.url)
        {
            return Err(RemoteError::Protocol(
                "applied push contains an empty or duplicate hosted upload URL".to_owned(),
            ));
        }
    }
    Ok(())
}

fn remote_tick_should_drain_more(tick: &RemoteTick) -> bool {
    tick.received > 0 || tick.rows_applied > 0 || tick.pull_changes_applied > 0
}

/// Whether `table` is a plausible local-id table prefix, matching the store's
/// identifier rule so a non-id string that merely contains `|` is never read as
/// an id-map key.
fn is_local_id_table(table: &str) -> bool {
    let bytes = table.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && !bytes[0].is_ascii_digit()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_')
}

/// A `table|suffix` local id that has no hosted mapping yet — a doc whose create has not acked. A
/// pure-CRDT (`fn:""`) push carrying such an id is buffered until the create maps it (§8 seam 3).
fn is_unresolved_local_id(text: &str) -> bool {
    match text.split_once('|') {
        Some((table, suffix)) => !suffix.is_empty() && is_local_id_table(table),
        None => false,
    }
}

fn sha256_json(value: &[serde_json::Value]) -> RemoteResult<String> {
    sha256_value(&serde_json::Value::Array(value.to_vec()))
}

fn sha256_value(value: &serde_json::Value) -> RemoteResult<String> {
    let bytes = serde_json::to_vec(&canonical_json(value))
        .map_err(|error| RemoteError::Protocol(format!("hash JSON encode failed: {error}")))?;
    let digest = Sha256::digest(bytes);
    Ok(digest.iter().fold(
        String::with_capacity(digest.len() * 2),
        |mut encoded, byte| {
            write!(encoded, "{byte:02x}").expect("writing to a String cannot fail");
            encoded
        },
    ))
}

fn canonical_json(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Array(values) => {
            serde_json::Value::Array(values.iter().map(canonical_json).collect())
        }
        serde_json::Value::Object(fields) => {
            let mut ordered = serde_json::Map::new();
            let mut keys = fields.keys().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                ordered.insert(key.clone(), canonical_json(&fields[key]));
            }
            serde_json::Value::Object(ordered)
        }
        scalar => scalar.clone(),
    }
}

fn function_result_error(function_name: &str, result: &FunctionResult) -> RemoteError {
    match result {
        FunctionResult::Value(_) => RemoteError::Protocol(format!(
            "{function_name} failed: expected Convex application error but received value"
        )),
        FunctionResult::ErrorMessage(message) => {
            RemoteError::Protocol(format!("{function_name} failed: {message}"))
        }
        FunctionResult::ConvexError(error) => {
            let message = format!(
                "{function_name} failed: {} data={:?}",
                error.message, error.data
            );
            match convex_error_code(&error.data) {
                Some("EMBEDDED_PROTOCOL_MISMATCH") => RemoteError::DeploymentMismatch(message),
                Some("EMBEDDED_CLIENT_RETIRED") => RemoteError::Retired(message),
                _ => RemoteError::Protocol(message),
            }
        }
    }
}

fn convex_error_code(data: &Value) -> Option<&str> {
    match data {
        Value::Object(fields) => match fields.get("code") {
            Some(Value::String(code)) => Some(code.as_str()),
            _ => None,
        },
        _ => None,
    }
}

fn mutation_reuse_prior_outcome(result: &FunctionResult) -> Option<PushOutcome> {
    let FunctionResult::ConvexError(error) = result else {
        return None;
    };
    let Value::Object(fields) = &error.data else {
        return None;
    };
    if fields.get("code") != Some(&Value::String("EMBEDDED_MUTATION_ID_REUSE".to_owned())) {
        return None;
    }
    let Value::String(outcome) = fields.get("priorOutcome")? else {
        return None;
    };
    PushOutcome::parse(outcome)
}

fn mutation_push_response(
    envelope: &PushEnvelope,
    result: &FunctionResult,
) -> RemoteResult<PushResponse> {
    match result {
        FunctionResult::Value(value) => push::decode_push_response(value),
        FunctionResult::ConvexError(_) | FunctionResult::ErrorMessage(_) => {
            Err(function_result_error(&envelope.function, result))
        }
    }
}

fn duration_millis_i64(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

fn json_pointer_write(
    value: &mut serde_json::Value,
    pointer: &str,
    replacement: serde_json::Value,
) -> RemoteResult<()> {
    let slot = value.pointer_mut(pointer).ok_or_else(|| {
        RemoteError::Protocol("pagination cursor path is missing from query arguments".to_owned())
    })?;
    *slot = replacement;
    Ok(())
}

/// Replay args (`require_all_mapped`) block on ANY unmapped local id — shipping one writes a
/// client-local id into shared state. Projections block only on `_storage` (a new doc's own id is
/// legitimately unmapped until the server assigns it).
fn sha256_hex(bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    codec::hex(&hash.finalize())
}

fn append_checkpoint_chunks(
    chunks: Vec<pull::CheckpointChunk>,
    checkpoint_cached: bool,
    bytes: &mut Vec<u8>,
    ordinal: &mut usize,
    pages: &mut usize,
) -> RemoteResult<()> {
    for chunk in chunks {
        *pages = pages.saturating_add(1);
        if checkpoint_cached || *pages > MAX_CHECKPOINT_CHUNKS {
            return Err(RemoteError::Protocol(
                "checkpoint pull returned unexpected or excessive chunks".to_owned(),
            ));
        }
        if chunk.ordinal != *ordinal || sha256_hex(&chunk.bytes) != chunk.hash {
            return Err(RemoteError::Protocol(
                "checkpoint chunk failed sequence or hash verification".to_owned(),
            ));
        }
        bytes.extend_from_slice(&chunk.bytes);
        *ordinal = ordinal.saturating_add(1);
    }
    Ok(())
}

fn append_checkpoint_payloads(
    payloads: Vec<pull::PullPayload>,
    updates: &mut Vec<Vec<u8>>,
    next_seq: &mut i64,
    pages: &mut usize,
) -> RemoteResult<()> {
    for payload in payloads {
        *pages = pages.saturating_add(1);
        if *pages > MAX_CHECKPOINT_PAYLOADS
            || payload.seq != *next_seq
            || sha256_hex(&payload.bytes) != payload.hash
        {
            return Err(RemoteError::Protocol(
                "checkpoint payload failed sequence, bound, or hash verification".to_owned(),
            ));
        }
        updates.push(payload.bytes);
        *next_seq += 1;
    }
    Ok(())
}

impl<T, C, U> RemoteDriver<T, Arc<storage::EmbeddedStore>, C, U>
where
    T: RemoteTransport,
    C: RemoteClock,
{
    #[must_use]
    pub fn store(&self) -> &Arc<storage::EmbeddedStore> {
        &self.store
    }
}

fn cached_first_token_fetcher(
    token: AuthenticationToken,
    fetcher: Arc<AuthTokenFetcher>,
) -> AuthTokenFetcher {
    cached_first_token_fetcher_inner(token, fetcher)
}

/// A fetcher that serves a freshly validated reconnect token to the immediate replay — the
/// `set_auth_fetcher` install (`force_refresh=false`, cloned) and the resend restart
/// (`force_refresh=true`, consumed) — so neither re-fetches; later refreshes delegate to the app
/// fetcher. Gating the resend on a successful pre-fetch keeps authenticated queries and mutations
/// from replaying on an unauthenticated connection.
fn reconnect_token_fetcher(
    token: AuthenticationToken,
    fetcher: Arc<AuthTokenFetcher>,
) -> AuthTokenFetcher {
    let pending = Arc::new(Mutex::new(Some(token)));
    Box::new(move |force_refresh| {
        let pending = Arc::clone(&pending);
        let fetcher = Arc::clone(&fetcher);
        Box::pin(async move {
            if force_refresh {
                let reserved = pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                match reserved {
                    Some(validated) => Ok(validated),
                    None => (fetcher.as_ref())(true).await,
                }
            } else {
                let cached = pending
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .clone();
                match cached {
                    Some(token) => Ok(token),
                    None => (fetcher.as_ref())(false).await,
                }
            }
        })
    })
}

fn cached_first_token_fetcher_inner(
    token: AuthenticationToken,
    fetcher: Arc<AuthTokenFetcher>,
) -> AuthTokenFetcher {
    let first = Arc::new(Mutex::new(Some(token)));
    Box::new(move |force_refresh| {
        let first = Arc::clone(&first);
        let fetcher = Arc::clone(&fetcher);
        Box::pin(async move {
            if !force_refresh {
                let cached = first
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take();
                if let Some(token) = cached {
                    return Ok(token);
                }
            }
            (fetcher.as_ref())(force_refresh).await
        })
    })
}

/// Content identity for a pull change's projection record: the LWW `server_base` stored after
/// adoption. Ordering is by pull `seq` (`logical_clock`), so this only distinguishes equal-seq
/// re-delivery; a stable hash of `(table, id, row)` suffices.
fn pull_change_hash(change: &storage::RowChange) -> String {
    let mut hash = Sha256::new();
    hash.update(change.table.as_bytes());
    hash.update([0u8]);
    hash.update(change.id.as_bytes());
    hash.update([0u8]);
    match &change.row {
        Some(row) => hash.update(row.as_bytes()),
        None => hash.update(b"__deleted__"),
    }
    format!("sha256:{}", codec::hex(&hash.finalize()))
}

fn pull_change_has_changed(
    change: &pull::PullChange,
    accepted: &BTreeMap<(String, String), pull::PullChange>,
) -> bool {
    let pull::PullChangeBody::Row(row) = &change.body;
    accepted
        .get(&(row.table.clone(), row.id.clone()))
        .is_none_or(|prior| prior.plain_hash != change.plain_hash || prior.rev != change.rev)
}

fn checkpoint_response(
    crdt: &pull::PullCrdt,
    checkpoint: &[u8],
    updates: &[Vec<u8>],
) -> Option<RemoteResult<PendingCheckpoint>> {
    let request = crdt.checkpoint_request.clone()?;
    Some(
        storage::crdt_checkpoint_response(
            crdt.kind,
            checkpoint,
            crdt.checkpoint.seq,
            updates,
            &request,
        )
        .map(|checkpoint| PendingCheckpoint {
            request,
            checkpoint,
        })
        .map_err(RemoteError::from),
    )
}

fn remote_member(member: pull::PullMember) -> storage::RemoteMember {
    storage::RemoteMember {
        table: member.table,
        server_document_id: member.id,
    }
}

#[allow(clippy::too_many_arguments)]
fn pull_projection_record(
    table: String,
    server_document_id: String,
    projection_hash: String,
    plain_hash: String,
    row: Option<String>,
    current_root_id: Option<String>,
    current_node_id: Option<String>,
    logical_clock: Option<f64>,
    received_time: i64,
) -> AuthoritativeRow {
    AuthoritativeRow {
        current_node_id,
        current_root_id,
        local_document_id: None,
        logical_clock,
        plain_hash,
        projection_hash,
        received_time,
        row,
        server_document_id,
        table,
    }
}

fn rejected_write_targets(envelope: &PushEnvelope) -> BTreeSet<(String, String)> {
    envelope
        .after_images
        .iter()
        .map(|candidate| (candidate.table.clone(), candidate.row_id.clone()))
        .chain(
            envelope
                .crdt
                .iter()
                .map(|effect| (effect.table.clone(), effect.row_id.clone())),
        )
        .collect()
}

fn rejected_target_should_retain(
    envelope: &PushEnvelope,
    revisions: &BTreeMap<(String, String), String>,
    key: &(String, String),
    retain_rejected: bool,
) -> bool {
    retain_rejected
        || revisions.contains_key(key)
        || envelope
            .crdt
            .iter()
            .any(|effect| (&effect.table, &effect.row_id) == (&key.0, &key.1))
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, BTreeSet, VecDeque},
        future,
        sync::{Arc, Mutex},
        time::Duration,
    };

    use convex_sync_types::{
        ClientMessage, LogLinesMessage, QuerySetModification, ServerMessage, StateModification,
        StateVersion,
    };
    use futures_util::{future::BoxFuture, FutureExt};
    use tokio::sync::{mpsc, oneshot, Notify};

    use super::{
        function_result_error, parse_identity_response, pull_change_has_changed,
        rejected_target_should_retain, rejected_write_targets, ActiveRemoteWrite,
        InflightRemotePush, InflightRemotePushKind, PendingCheckpoint, PendingRemoteWrite,
        PullSubscription, RemoteCommand, RemoteDriver, RemoteScope, RemoteSubscription,
        RemoteWrite,
    };
    use crate::{
        config::{RemoteConfig, RemoteFunction},
        transport::{ConnectRequest, RemoteTransport, TransportEvent},
        RemoteError, RemotePending, RemoteTick, SystemRemoteClock,
    };
    use convex::{base_client::FunctionResult, ConvexError, Value};

    #[test]
    fn identity_response_accepts_only_the_current_protocol() {
        let authenticated = parse_identity_response(&serde_json::json!({
            "identity": null,
            "identityKey": "deadbeef",
            "protocolVersion": crate::config::EMBEDDED_PROTOCOL_VERSION,
        }))
        .unwrap();
        assert_eq!(authenticated.identity_key, "deadbeef");
        assert_eq!(authenticated.identity_json, None);

        let unauthenticated = parse_identity_response(&serde_json::json!({
            "identity": null,
            "protocolVersion": crate::config::EMBEDDED_PROTOCOL_VERSION,
        }))
        .unwrap();
        assert_eq!(
            unauthenticated.identity_key,
            crate::config::EMBEDDED_UNAUTHENTICATED_IDENTITY_KEY
        );
        assert_eq!(unauthenticated.identity_json, None);

        for response in [
            serde_json::json!({
                "identity": null,
                "identityKey": "deadbeef",
            }),
            serde_json::json!({
                "identity": null,
                "identityKey": "deadbeef",
                "protocolVersion": crate::config::EMBEDDED_PROTOCOL_VERSION - 1,
            }),
        ] {
            assert!(matches!(
                parse_identity_response(&response),
                Err(RemoteError::DeploymentMismatch(_))
            ));
        }
    }

    #[test]
    fn accepted_pull_rows_filter_unchanged_projections() {
        let change = crate::pull::PullChange {
            body: crate::pull::PullChangeBody::Row(storage::RowChange {
                op: storage::RowChangeOp::Write,
                table: "documents".into(),
                id: "document:1".into(),
                row: Some(r#"{"title":"before"}"#.into()),
            }),
            plain_hash: "plain:before".into(),
            rev: None,
        };
        let accepted =
            BTreeMap::from([(("documents".into(), "document:1".into()), change.clone())]);

        assert!(!pull_change_has_changed(&change, &accepted));
        let mut changed = change;
        let crate::pull::PullChangeBody::Row(row) = &mut changed.body;
        row.row = Some(r#"{"title":"after","body":"crdt"}"#.into());
        assert!(!pull_change_has_changed(&changed, &accepted));
        changed.plain_hash = "plain:after".into();
        assert!(pull_change_has_changed(&changed, &accepted));
    }

    struct WaitingTransport {
        waited: Arc<Notify>,
    }

    #[derive(Default)]
    struct TransportTrace {
        auto_respond_to_mutations: bool,
        connect_failures: usize,
        connects: usize,
        events: VecDeque<TransportEvent>,
        mutation_settlements: VecDeque<FunctionResult>,
        query_results: VecDeque<Value>,
        sent: Vec<ClientMessage>,
        state_version: Option<StateVersion>,
    }

    struct TraceTransport {
        trace: Arc<Mutex<TransportTrace>>,
    }

    impl RemoteTransport for TraceTransport {
        type Connect<'a> = BoxFuture<'a, crate::RemoteResult<()>>;
        type SendMessage<'a> = BoxFuture<'a, crate::RemoteResult<()>>;
        type Receive<'a> = BoxFuture<'a, crate::RemoteResult<TransportEvent>>;
        type Close<'a> = BoxFuture<'a, crate::RemoteResult<()>>;

        fn connect(&mut self, _request: ConnectRequest) -> Self::Connect<'_> {
            let mut trace = self
                .trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            trace.connects += 1;
            if trace.connect_failures > 0 {
                trace.connect_failures -= 1;
                return future::ready(Err(RemoteError::Transport(
                    "injected connect failure".to_owned(),
                )))
                .boxed();
            }
            future::ready(Ok(())).boxed()
        }

        fn send(&mut self, message: ClientMessage) -> Self::SendMessage<'_> {
            let mut trace = self
                .trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let request_id = match &message {
                ClientMessage::Mutation { request_id, .. } if trace.auto_respond_to_mutations => {
                    Some(*request_id)
                }
                _ => None,
            };
            let query_set = match &message {
                ClientMessage::ModifyQuerySet {
                    base_version,
                    modifications,
                    new_version,
                } => Some((
                    *base_version,
                    *new_version,
                    modifications
                        .iter()
                        .filter_map(|modification| match modification {
                            QuerySetModification::Add(query) => Some(query.query_id),
                            QuerySetModification::Remove { .. } => None,
                        })
                        .collect::<Vec<_>>(),
                )),
                _ => None,
            };
            trace.sent.push(message);
            if let Some(request_id) = request_id {
                let settlement = trace
                    .mutation_settlements
                    .pop_front()
                    .unwrap_or(FunctionResult::Value(Value::Null));
                let start = trace.state_version.unwrap_or_else(StateVersion::initial);
                let (events, end) = covering_mutation_events_after(start, request_id, settlement);
                trace.state_version = Some(end);
                trace.events.extend(events);
            }
            if let Some((base_version, new_version, query_ids)) = query_set
                .filter(|_| trace.state_version.is_some() || !trace.query_results.is_empty())
            {
                let start = trace.state_version.unwrap_or_else(StateVersion::initial);
                debug_assert_eq!(start.query_set, base_version);
                let end = StateVersion {
                    query_set: new_version,
                    ts: start.ts.succ().expect("test timestamp should advance"),
                    ..start
                };
                let modifications = query_ids
                    .into_iter()
                    .filter_map(|query_id| {
                        trace.query_results.pop_front().map(|result| {
                            StateModification::QueryUpdated {
                                query_id,
                                value: result,
                                log_lines: LogLinesMessage(Vec::new()),
                                journal: None,
                            }
                        })
                    })
                    .collect();
                trace.state_version = Some(end);
                trace
                    .events
                    .push_back(TransportEvent::ServerMessage(ServerMessage::Transition {
                        start_version: start,
                        end_version: end,
                        modifications,
                        client_clock_skew: None,
                        server_ts: None,
                    }));
            }
            future::ready(Ok(())).boxed()
        }

        fn receive(&mut self, _timeout: Duration) -> Self::Receive<'_> {
            let event = self
                .trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .events
                .pop_front()
                .unwrap_or(TransportEvent::Timeout);
            future::ready(Ok(event)).boxed()
        }

        fn receive_wait(&mut self) -> Self::Receive<'_> {
            let event = self
                .trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .events
                .pop_front();
            match event {
                Some(event) => future::ready(Ok(event)).boxed(),
                None => future::pending().boxed(),
            }
        }

        fn close(&mut self) -> Self::Close<'_> {
            future::ready(Ok(())).boxed()
        }
    }

    fn test_store(name: &str) -> Arc<storage::EmbeddedStore> {
        let path = storage::testkit::tmp_path(name);
        let store = Arc::new(storage::EmbeddedStore::open(path.to_str().unwrap()).unwrap());
        store.setup(&storage::testkit::schema()).unwrap();
        store
    }

    fn empty_pull_result() -> storage::RemotePageWriteResult {
        storage::RemotePageWriteResult {
            rev_write: storage::RevWriteResult {
                duplicates: 0,
                written: 0,
            },
            projection: storage::AuthoritativeApplyResult {
                committed: Vec::new(),
                reroots: Vec::new(),
            },
            projection_deleted: 0,
            crdt: Vec::new(),
            result_changed: None,
        }
    }

    fn replay_envelope_json(mutation_id: &str, commit_seq: i64) -> String {
        serde_json::json!({
            "mutationId": mutation_id,
            "commitSeq": commit_seq,
            "clientRuntime": {
                "schemaHash": "local",
                "moduleGraphHash": "local",
                "protocolVersion": crate::config::EMBEDDED_PROTOCOL_VERSION,
            },
            "functionName": "documents:write",
            "args": {},
            "resultHash": "result",
            "idPaths": [],
            "mutationTime": 1,
            "randomSeed": "seed",
            "localInserts": [],
            "localSchedules": [],
            "inserts": [],
            "argRefs": [],
            "reads": [],
            "schedules": [],
            "uploads": [],
            "afterImages": [],
            "crdt": [],
            "revisionCheckpoints": [],
        })
        .to_string()
    }

    fn empty_remote_write(subscription: &str) -> RemoteWrite {
        RemoteWrite::Page(storage::RemotePageWrite {
            subscription: subscription.to_owned(),
            members: Vec::new(),
            projections: Vec::new(),
            crdt: Vec::new(),
            blobs: Vec::new(),
            cursor: None,
            received_time: 0,
            result: None,
        })
    }

    fn covering_mutation_events(
        request_id: convex_sync_types::SessionRequestSeqNumber,
        result: FunctionResult,
    ) -> [TransportEvent; 2] {
        covering_mutation_events_after(StateVersion::initial(), request_id, result).0
    }

    fn covering_mutation_events_after(
        start: StateVersion,
        request_id: convex_sync_types::SessionRequestSeqNumber,
        result: FunctionResult,
    ) -> ([TransportEvent; 2], StateVersion) {
        let end = StateVersion {
            ts: start.ts.succ().expect("test timestamp should advance"),
            ..start
        };
        (
            [
                TransportEvent::ServerMessage(ServerMessage::MutationResponse {
                    request_id,
                    result: result.into(),
                    ts: Some(end.ts),
                    log_lines: LogLinesMessage(Vec::new()),
                }),
                TransportEvent::ServerMessage(ServerMessage::Transition {
                    start_version: start,
                    end_version: end,
                    modifications: Vec::new(),
                    client_clock_skew: None,
                    server_ts: None,
                }),
            ],
            end,
        )
    }

    fn applied_push_result(mutation_id: &str) -> FunctionResult {
        FunctionResult::Value(Value::Object(BTreeMap::from([
            (
                "mutationId".to_owned(),
                Value::String(mutation_id.to_owned()),
            ),
            ("outcome".to_owned(), Value::String("applied".to_owned())),
            ("result".to_owned(), Value::Null),
            ("inserts".to_owned(), Value::Array(Vec::new())),
            ("schedules".to_owned(), Value::Array(Vec::new())),
            ("uploads".to_owned(), Value::Array(Vec::new())),
            ("revisions".to_owned(), Value::Array(Vec::new())),
            ("crdt".to_owned(), Value::Array(Vec::new())),
            ("authoritative".to_owned(), Value::Array(Vec::new())),
        ])))
    }

    fn crdt_envelope_json(mutation_id: &str, commit_seq: i64, base_seq: i64) -> String {
        serde_json::json!({
            "mutationId": mutation_id,
            "commitSeq": commit_seq,
            "clientRuntime": {
                "schemaHash": "local",
                "moduleGraphHash": "local",
                "protocolVersion": crate::config::EMBEDDED_PROTOCOL_VERSION,
            },
            "functionName": "documents:writeBody",
            "args": {},
            "resultHash": "result",
            "idPaths": [],
            "mutationTime": 1,
            "randomSeed": "seed",
            "localInserts": [],
            "localSchedules": [],
            "inserts": [],
            "argRefs": [],
            "reads": [],
            "schedules": [],
            "uploads": [],
            "afterImages": [],
            "crdt": [{
                "table": "documents",
                "rowId": "documents|row",
                "field": "body",
                "kind": "text",
                "baseSeq": base_seq,
                "projection": "abc",
                "projectionHash": "projection-hash",
                "payload": { "$bytes": "" },
            }],
            "revisionCheckpoints": [],
        })
        .to_string()
    }

    fn rebase_push_result(mutation_id: &str) -> FunctionResult {
        FunctionResult::Value(Value::Object(BTreeMap::from([
            (
                "mutationId".to_owned(),
                Value::String(mutation_id.to_owned()),
            ),
            ("outcome".to_owned(), Value::String("rebase".to_owned())),
            (
                "error".to_owned(),
                Value::String("crdt base sequence is stale".to_owned()),
            ),
            ("inserts".to_owned(), Value::Array(Vec::new())),
            ("schedules".to_owned(), Value::Array(Vec::new())),
            ("uploads".to_owned(), Value::Array(Vec::new())),
            ("revisions".to_owned(), Value::Array(Vec::new())),
            ("crdt".to_owned(), Value::Array(Vec::new())),
            ("authoritative".to_owned(), Value::Array(Vec::new())),
        ])))
    }

    fn conflict_push_result(mutation_id: &str) -> FunctionResult {
        FunctionResult::Value(Value::Object(BTreeMap::from([
            (
                "mutationId".to_owned(),
                Value::String(mutation_id.to_owned()),
            ),
            ("outcome".to_owned(), Value::String("conflict".to_owned())),
            (
                "error".to_owned(),
                Value::String("authoritative state changed".to_owned()),
            ),
            ("inserts".to_owned(), Value::Array(Vec::new())),
            ("schedules".to_owned(), Value::Array(Vec::new())),
            ("uploads".to_owned(), Value::Array(Vec::new())),
            ("revisions".to_owned(), Value::Array(Vec::new())),
            ("crdt".to_owned(), Value::Array(Vec::new())),
            ("authoritative".to_owned(), Value::Array(Vec::new())),
        ])))
    }

    fn mutation_reuse_result(outcome: &str) -> FunctionResult {
        FunctionResult::ConvexError(ConvexError {
            message: "Mutation ID was reused with a different replay fingerprint.".to_owned(),
            data: Value::Object(BTreeMap::from([
                (
                    "code".to_owned(),
                    Value::String("EMBEDDED_MUTATION_ID_REUSE".to_owned()),
                ),
                ("priorOutcome".to_owned(), Value::String(outcome.to_owned())),
            ])),
        })
    }

    async fn wait_for_actor_trace(
        trace: &Arc<Mutex<Vec<&'static str>>>,
        expected: &[&'static str],
        message: &'static str,
    ) {
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if trace
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_slice()
                    == expected
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect(message);
    }

    impl RemoteTransport for WaitingTransport {
        type Connect<'a> = BoxFuture<'a, crate::RemoteResult<()>>;
        type SendMessage<'a> = BoxFuture<'a, crate::RemoteResult<()>>;
        type Receive<'a> = BoxFuture<'a, crate::RemoteResult<TransportEvent>>;
        type Close<'a> = BoxFuture<'a, crate::RemoteResult<()>>;

        fn connect(&mut self, _request: ConnectRequest) -> Self::Connect<'_> {
            async { Ok(()) }.boxed()
        }

        fn send(&mut self, _message: convex_sync_types::ClientMessage) -> Self::SendMessage<'_> {
            async { Ok(()) }.boxed()
        }

        fn receive(&mut self, _timeout: Duration) -> Self::Receive<'_> {
            async { Ok(TransportEvent::Timeout) }.boxed()
        }

        fn receive_wait(&mut self) -> Self::Receive<'_> {
            let waited = Arc::clone(&self.waited);
            async move {
                waited.notify_one();
                future::pending().await
            }
            .boxed()
        }

        fn close(&mut self) -> Self::Close<'_> {
            async { Ok(()) }.boxed()
        }
    }

    #[test]
    fn protocol_mismatch_application_error_has_a_terminal_category() {
        let result = FunctionResult::ConvexError(ConvexError {
            message: "Embedded protocol 5 is not supported.".to_owned(),
            data: Value::Object(BTreeMap::from([(
                "code".to_owned(),
                Value::String("EMBEDDED_PROTOCOL_MISMATCH".to_owned()),
            )])),
        });

        assert!(matches!(
            function_result_error("embedded:pull", &result),
            RemoteError::DeploymentMismatch(message)
                if message.contains("Embedded protocol 5 is not supported")
        ));
    }

    #[test]
    fn client_retirement_convex_error_survives_prod_redaction() {
        let result = FunctionResult::ConvexError(ConvexError {
            message: "Embedded remote client has been permanently retired.".to_owned(),
            data: Value::Object(BTreeMap::from([(
                "code".to_owned(),
                Value::String("EMBEDDED_CLIENT_RETIRED".to_owned()),
            )])),
        });

        let error = function_result_error("embedded:push", &result);
        assert!(matches!(&error, RemoteError::Retired(_)));
        assert!(!error.is_transient());
    }

    #[test]
    fn a_plain_application_error_is_never_retirement() {
        assert!(matches!(
            function_result_error(
                "embedded:push",
                &FunctionResult::ErrorMessage(
                    "Embedded remote client has been permanently retired.".to_owned(),
                ),
            ),
            RemoteError::Protocol(_)
        ));
        assert!(matches!(
            function_result_error(
                "embedded:push",
                &FunctionResult::ErrorMessage("some other failure".to_owned()),
            ),
            RemoteError::Protocol(_)
        ));
    }

    #[test]
    fn rejected_targets_include_crdt_only_rows_and_deduplicate_mixed_rows() {
        let mut envelope = storage::PushEnvelope {
            mutation_id: "mutation".to_owned(),
            replay_id: "mutation".to_owned(),
            logical_fingerprint: "logical".to_owned(),
            commit_seq: 1,
            runtime: storage::RuntimeWireIdentity {
                schema_hash: "schema".to_owned(),
                module_graph_hash: "modules".to_owned(),
                protocol_version: 5,
            },
            function: "documents:write".to_owned(),
            args: serde_json::Value::Null,
            result_hash: "result".to_owned(),
            id_paths: Vec::new(),
            mutation_time_hlc: 1.0,
            rng_seed: "seed".to_owned(),
            id_allocations: Vec::new(),
            local_schedule_ids: Vec::new(),
            inserts: Vec::new(),
            arg_refs: Vec::new(),
            read_set: Vec::new(),
            schedules: Vec::new(),
            uploads: Vec::new(),
            after_images: Vec::new(),
            crdt: Vec::new(),
            revision_checkpoints: Vec::new(),
        };
        envelope.after_images.push(storage::RevisionCandidate {
            table: "documents".to_owned(),
            row_id: "documents|mixed".to_owned(),
            content: storage::RevisionContent::Value(serde_json::json!({ "title": "mixed" })),
        });
        envelope.after_images.push(storage::RevisionCandidate {
            table: "documents".to_owned(),
            row_id: "documents|plain".to_owned(),
            content: storage::RevisionContent::Value(serde_json::json!({ "title": "plain" })),
        });
        envelope.crdt.extend([
            storage::CrdtEffect {
                table: "documents".to_owned(),
                row_id: "documents|mixed".to_owned(),
                field: "body".to_owned(),
                kind: storage::CrdtFieldKind::Text,
                base_seq: 0,
                projection: serde_json::json!("mixed"),
                projection_hash: "mixed-hash".to_owned(),
                payload: vec![1],
                checkpoint: None,
            },
            storage::CrdtEffect {
                table: "documents".to_owned(),
                row_id: "documents|crdt".to_owned(),
                field: "body".to_owned(),
                kind: storage::CrdtFieldKind::Text,
                base_seq: 0,
                projection: serde_json::json!("crdt"),
                projection_hash: "crdt-hash".to_owned(),
                payload: vec![2],
                checkpoint: None,
            },
        ]);

        assert_eq!(
            rejected_write_targets(&envelope),
            BTreeSet::from([
                ("documents".to_owned(), "documents|crdt".to_owned()),
                ("documents".to_owned(), "documents|mixed".to_owned()),
                ("documents".to_owned(), "documents|plain".to_owned()),
            ]),
        );
        let plain = ("documents".to_owned(), "documents|plain".to_owned());
        let crdt = ("documents".to_owned(), "documents|crdt".to_owned());
        assert!(!rejected_target_should_retain(
            &envelope,
            &BTreeMap::new(),
            &plain,
            false,
        ));
        assert!(rejected_target_should_retain(
            &envelope,
            &BTreeMap::new(),
            &crdt,
            false,
        ));
        assert!(rejected_target_should_retain(
            &envelope,
            &BTreeMap::from([(plain.clone(), "rev:plain".to_owned())]),
            &plain,
            false,
        ));
        assert!(rejected_target_should_retain(
            &envelope,
            &BTreeMap::new(),
            &plain,
            true,
        ));
    }

    #[tokio::test]
    async fn authored_watch_change_adds_before_remove_and_rebase_retains_subscription() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-subscription-order.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let old = RemoteSubscription {
            pull_fn: "issues:old".to_owned(),
            pull_args: serde_json::json!({}),
            result_cache_key: None,
            cursor: None,
        };
        let old_key = super::remote_subscription_key(&old).unwrap();
        let old_args = crate::pull::args(&driver.config.runtime, &old.pull_fn, &old.pull_args)
            .expect("old pull args should encode");
        let old_id = driver.base.subscribe(
            crate::protocol::pull_function().unwrap().into_udf_path(),
            old_args,
        );
        driver.pull_subscriptions.push(PullSubscription {
            last_result: None,
            last_failed_result: None,
            key: old_key,
            subscriber_id: old_id,
            cursor: None,
        });
        driver.scope = RemoteScope {
            subscriptions: vec![old],
        };
        driver.flush_outbound().await.unwrap();
        trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .clear();

        let new = RemoteSubscription {
            pull_fn: "issues:new".to_owned(),
            pull_args: serde_json::json!({}),
            result_cache_key: None,
            cursor: None,
        };
        let new_key = super::remote_subscription_key(&new).unwrap();
        driver
            .scope_write(RemoteScope {
                subscriptions: vec![new.clone()],
            })
            .unwrap();
        let (added, _) = driver.subscribe_missing().await.unwrap();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].0, new_key);
        driver.remove_retired_subscriptions().unwrap();
        driver.start_next_remote_write();
        driver.flush_outbound().await.unwrap();

        assert!(matches!(
            driver
                .remote_write_active
                .as_ref()
                .map(|active| &active.pending.write),
            Some(RemoteWrite::SubscriptionDelete { .. })
        ));

        let operations = trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .iter()
            .flat_map(|message| match message {
                ClientMessage::ModifyQuerySet { modifications, .. } => modifications
                    .iter()
                    .map(|modification| match modification {
                        QuerySetModification::Add(_) => "add",
                        QuerySetModification::Remove { .. } => "remove",
                    })
                    .collect::<Vec<_>>(),
                _ => Vec::new(),
            })
            .collect::<Vec<_>>();
        assert_eq!(operations, vec!["add", "remove"]);

        driver.drive_remote_write_with_ingress().await.unwrap();

        trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .clear();
        let retained = driver.pull_subscriptions[0].subscriber_id;
        driver.wait_for_rebase_remote_write();
        driver.flush_outbound().await.unwrap();
        assert_eq!(driver.pull_subscriptions[0].subscriber_id, retained);
        assert!(trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .is_empty());
    }

    #[tokio::test]
    async fn covering_transition_settles_before_queued_remote_write_and_ingress_keeps_running() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-actor-order.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        let actor_trace = Arc::clone(&driver.actor_trace);
        let remote_write_release = Arc::new(Notify::new());
        let release = Arc::clone(&remote_write_release);
        driver.remote_write_active = Some(ActiveRemoteWrite {
            future: Box::pin(async move {
                release.notified().await;
                Ok(empty_pull_result())
            }),
            pending: PendingRemoteWrite {
                checkpoint_responses: Vec::new(),
                crdt_changes: 0,
                pull_changes: 0,
                result: Some(FunctionResult::Value(Value::Null)),
                subscription: "watch".to_owned(),
                write: empty_remote_write("watch"),
            },
        });
        let checkpoint_id = "checkpoint".to_owned();
        driver.pending_checkpoints.push_back(PendingCheckpoint {
            request: storage::CrdtCheckpointRequest {
                checkpoint_id: checkpoint_id.clone(),
                response_token: "response".to_owned(),
                through_seq: 1,
                projection_hash: "projection".to_owned(),
            },
            checkpoint: storage::CrdtCheckpoint {
                through_seq: 1,
                bytes: Vec::new(),
                hash: "hash".to_owned(),
            },
        });
        let result = driver
            .base
            .mutation("embedded:push".parse().unwrap(), BTreeMap::new());
        driver.flush_outbound().await.unwrap();
        let request_id = trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .iter()
            .find_map(|message| match message {
                ClientMessage::Mutation { request_id, .. } => Some(*request_id),
                _ => None,
            })
            .expect("base client should emit the foreground mutation");
        trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .events
            .extend(covering_mutation_events(
                request_id,
                FunctionResult::Value(Value::Null),
            ));
        driver.inflight_remote_push.push_back(InflightRemotePush {
            kind: InflightRemotePushKind::Checkpoint { checkpoint_id },
            result,
        });

        let (commands, receiver) = mpsc::channel(1);
        let task = tokio::spawn(driver.run_with_observer(receiver, |_| {}));
        wait_for_actor_trace(
            &actor_trace,
            &["mutation_response", "transition", "settlement"],
            "socket ingress and settlement were blocked by remote-write work",
        )
        .await;
        remote_write_release.notify_one();
        wait_for_actor_trace(
            &actor_trace,
            &[
                "mutation_response",
                "transition",
                "settlement",
                "remote_write",
            ],
            "queued remote write did not complete",
        )
        .await;

        let (response, completed) = oneshot::channel();
        commands
            .send(RemoteCommand::Close { response })
            .await
            .unwrap();
        completed.await.unwrap().unwrap();
        task.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn remote_write_completion_flushes_checkpoint_without_pull_command() {
        let trace = Arc::new(Mutex::new(TransportTrace {
            auto_respond_to_mutations: true,
            ..TransportTrace::default()
        }));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-checkpoint-autoflush.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        driver.remote_write_active = Some(ActiveRemoteWrite {
            future: future::ready(Ok(empty_pull_result())).boxed(),
            pending: PendingRemoteWrite {
                checkpoint_responses: vec![PendingCheckpoint {
                    request: storage::CrdtCheckpointRequest {
                        checkpoint_id: "checkpoint".to_owned(),
                        response_token: "response".to_owned(),
                        through_seq: 1,
                        projection_hash: "projection".to_owned(),
                    },
                    checkpoint: storage::CrdtCheckpoint {
                        through_seq: 1,
                        bytes: Vec::new(),
                        hash: "hash".to_owned(),
                    },
                }],
                crdt_changes: 0,
                pull_changes: 0,
                result: Some(FunctionResult::Value(Value::Null)),
                subscription: "watch".to_owned(),
                write: empty_remote_write("watch"),
            },
        });

        let (commands, receiver) = mpsc::channel(1);
        let task = tokio::spawn(driver.run_with_observer(receiver, |_| {}));
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                let mutation_sent = trace
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .sent
                    .iter()
                    .any(|message| matches!(message, ClientMessage::Mutation { .. }));
                if mutation_sent {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("remote-write completion did not flush its checkpoint mutation");

        let (response, completed) = oneshot::channel();
        commands
            .send(RemoteCommand::Close { response })
            .await
            .unwrap();
        completed.await.unwrap().unwrap();
        task.await.unwrap().unwrap();

        let mutation_count = trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .iter()
            .filter(|message| matches!(message, ClientMessage::Mutation { .. }))
            .count();
        assert_eq!(mutation_count, 1);
    }

    #[tokio::test]
    async fn reconnect_resends_each_query_and_mutation_once() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-reconnect.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        let subscriber_id = driver
            .base
            .subscribe("issues:read".parse().unwrap(), BTreeMap::new());
        driver.pull_subscriptions.push(PullSubscription {
            last_result: None,
            last_failed_result: None,
            key: "issues".to_owned(),
            subscriber_id,
            cursor: None,
        });
        let _mutation = driver
            .base
            .mutation("issues:write".parse().unwrap(), BTreeMap::new());
        driver.flush_outbound().await.unwrap();
        {
            let mut trace = trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            trace.sent.clear();
            trace.connects = 0;
        }

        assert!(driver.reconnect("test reconnect".to_owned()).await.unwrap());
        driver.flush_outbound().await.unwrap();
        let trace = trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(driver.pull_subscriptions[0].subscriber_id, subscriber_id);
        assert_eq!(trace.connects, 1);
        assert_eq!(
            trace
                .sent
                .iter()
                .filter(|message| matches!(message, ClientMessage::Mutation { .. }))
                .count(),
            1
        );
        assert_eq!(
            trace
                .sent
                .iter()
                .flat_map(|message| match message {
                    ClientMessage::ModifyQuerySet { modifications, .. } => modifications.iter(),
                    _ => [].iter(),
                })
                .filter(|modification| matches!(modification, QuerySetModification::Add(_)))
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn reconnect_auth_gate_blocks_resend_until_token_refresh_succeeds() {
        use std::sync::atomic::{AtomicBool, Ordering};

        use convex::{base_client::AuthTokenFetcher, AuthenticationToken};

        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let fetch_ok = Arc::new(AtomicBool::new(true));
        let fetch_ok_closure = Arc::clone(&fetch_ok);
        let fetcher: AuthTokenFetcher = Box::new(move |_force_refresh| {
            let ok = fetch_ok_closure.load(Ordering::SeqCst);
            async move {
                if ok {
                    Ok(AuthenticationToken::User("jwt".to_owned()))
                } else {
                    Err(anyhow::anyhow!("token fetch failed"))
                }
            }
            .boxed()
        });
        let mut config = RemoteConfig::new("https://example.convex.cloud".parse().unwrap());
        config.auth = crate::config::RemoteAuth::Fetcher(Arc::new(fetcher));
        let mut driver = RemoteDriver::open_with_store(
            config,
            test_store("remote-reconnect-auth.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        let subscriber_id = driver
            .base
            .subscribe("issues:read".parse().unwrap(), BTreeMap::new());
        driver.pull_subscriptions.push(PullSubscription {
            last_result: None,
            last_failed_result: None,
            key: "issues".to_owned(),
            subscriber_id,
            cursor: None,
        });
        let _mutation = driver
            .base
            .mutation("issues:write".parse().unwrap(), BTreeMap::new());
        driver.flush_outbound().await.unwrap();

        let mutation_count = |trace: &TransportTrace| {
            trace
                .sent
                .iter()
                .filter(|message| matches!(message, ClientMessage::Mutation { .. }))
                .count()
        };
        let query_add_count = |trace: &TransportTrace| {
            trace
                .sent
                .iter()
                .flat_map(|message| match message {
                    ClientMessage::ModifyQuerySet { modifications, .. } => modifications.iter(),
                    _ => [].iter(),
                })
                .filter(|modification| matches!(modification, QuerySetModification::Add(_)))
                .count()
        };

        {
            let mut trace = trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            trace.sent.clear();
            trace.connects = 0;
        }
        fetch_ok.store(false, Ordering::SeqCst);
        assert!(!driver.reconnect("auth gate".to_owned()).await.unwrap());
        driver.flush_outbound().await.unwrap();
        assert!(!driver.connected);
        {
            let trace = trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert_eq!(trace.connects, 1);
            assert_eq!(mutation_count(&trace), 0);
            assert_eq!(query_add_count(&trace), 0);
        }

        {
            let mut trace = trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            trace.sent.clear();
            trace.connects = 0;
        }
        fetch_ok.store(true, Ordering::SeqCst);
        assert!(driver.reconnect("auth gate".to_owned()).await.unwrap());
        driver.flush_outbound().await.unwrap();
        assert!(driver.connected);
        {
            let trace = trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            assert_eq!(trace.connects, 1);
            assert_eq!(mutation_count(&trace), 1);
            assert_eq!(query_add_count(&trace), 1);
        }
    }

    #[tokio::test]
    async fn remote_receipt_propagates_a_terminal_push_result() {
        let store = test_store("remote-ack-terminal.db");
        let mut envelope: serde_json::Value =
            serde_json::from_str(&replay_envelope_json("ack-me", 1)).unwrap();
        envelope["replayId"] = serde_json::Value::String("replay:ack-me".to_owned());
        store
            .remote_push_envelope_write("ack-me", 1, &envelope.to_string(), 1)
            .unwrap();
        store
            .remote_settlement_write(&storage::RemoteSettlementWrite {
                mutation_id: "ack-me".to_owned(),
                expected_commit_seq: 1,
                now_ms: 0,
                outcome: storage::RemoteSettlementOutcome::Applied {
                    ids: Vec::new(),
                    schedules: Vec::new(),
                    projections: Vec::new(),
                    crdt: Vec::new(),
                },
            })
            .unwrap();
        assert_eq!(
            store.remote_receipt_read(8).unwrap(),
            vec!["replay:ack-me".to_owned()]
        );

        let trace = Arc::new(Mutex::new(TransportTrace {
            auto_respond_to_mutations: true,
            mutation_settlements: VecDeque::from([FunctionResult::ConvexError(ConvexError {
                message: "Embedded remote client has been permanently retired.".to_owned(),
                data: Value::Object(BTreeMap::from([(
                    "code".to_owned(),
                    Value::String("EMBEDDED_CLIENT_RETIRED".to_owned()),
                )])),
            })]),
            ..TransportTrace::default()
        }));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            store,
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        driver.receipt_queue_empty = false;

        let error = driver.acknowledge_settlements().await.unwrap_err();
        assert!(matches!(error, RemoteError::Retired(_)), "{error:?}");
    }

    #[tokio::test]
    async fn remote_receipt_swallows_a_transient_mutation_failure() {
        let store = test_store("remote-ack-transient.db");
        store
            .remote_push_envelope_write("ack-me", 1, &replay_envelope_json("ack-me", 1), 1)
            .unwrap();
        store
            .remote_settlement_write(&storage::RemoteSettlementWrite {
                mutation_id: "ack-me".to_owned(),
                expected_commit_seq: 1,
                now_ms: 0,
                outcome: storage::RemoteSettlementOutcome::Applied {
                    ids: Vec::new(),
                    schedules: Vec::new(),
                    projections: Vec::new(),
                    crdt: Vec::new(),
                },
            })
            .unwrap();

        let trace = Arc::new(Mutex::new(TransportTrace {
            connect_failures: 1,
            ..TransportTrace::default()
        }));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            store,
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = false;
        driver.receipt_queue_empty = false;

        let tick = driver.acknowledge_settlements().await.unwrap();
        assert_eq!(tick.receipts_pushed, 0);
    }

    #[tokio::test]
    async fn browser_pull_ready_reports_no_scope_after_the_initial_page_write() {
        let trace = Arc::new(Mutex::new(TransportTrace {
            query_results: VecDeque::from([Value::try_from(serde_json::json!({
                "members": [],
                "changes": [],
                "crdt": [],
            }))
            .unwrap()]),
            state_version: Some(StateVersion::initial()),
            ..TransportTrace::default()
        }));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-browser-initial-pending.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        driver
            .scope_write(RemoteScope {
                subscriptions: vec![RemoteSubscription {
                    pull_fn: "documents:list".to_owned(),
                    pull_args: serde_json::json!({}),
                    result_cache_key: None,
                    cursor: None,
                }],
            })
            .unwrap();

        let tick = driver
            .pull_ready_interruptible(false, || false)
            .await
            .unwrap();

        assert_eq!(tick.pull_snapshots, 1);
        assert_eq!(tick.pending, Some(RemotePending::default()));
    }

    #[tokio::test]
    async fn browser_pull_ready_settles_and_acknowledges_the_final_replay() {
        let store = test_store("remote-browser-settlement-pending.db");
        store
            .remote_push_envelope_write("settled", 1, &replay_envelope_json("settled", 1), 1)
            .unwrap();

        let trace = Arc::new(Mutex::new(TransportTrace {
            auto_respond_to_mutations: true,
            mutation_settlements: VecDeque::from([applied_push_result("settled")]),
            ..TransportTrace::default()
        }));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            store,
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        let pushed = driver
            .doc_push(
                "documents",
                "documents|row",
                storage::DirtyHeadToken {
                    first_commit_seq: 1,
                    updated_commit_seq: 1,
                },
            )
            .await
            .unwrap();
        assert_eq!(
            pushed.tick.pending,
            Some(RemotePending {
                inflight: 1,
                mutations: 1,
                ..RemotePending::default()
            })
        );

        let tick = driver
            .pull_ready_interruptible(false, || false)
            .await
            .unwrap();

        assert_eq!(tick.push_accepted, 1);
        assert_eq!(tick.receipts_pushed, 1);
        assert_eq!(tick.pending, Some(RemotePending::default()));
    }

    #[tokio::test]
    async fn replay_lane_dispatches_ready_prefix_before_any_response() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-replay-lane.db");
        store
            .remote_push_envelope_write("first", 1, &replay_envelope_json("first", 1), 1)
            .unwrap();
        store
            .remote_push_envelope_write("second", 2, &replay_envelope_json("second", 2), 2)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            store,
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let pushed = driver
            .doc_push(
                "documents",
                "documents|row",
                storage::DirtyHeadToken {
                    first_commit_seq: 1,
                    updated_commit_seq: 2,
                },
            )
            .await
            .unwrap();

        assert_eq!(pushed.tick.push_attempted, 2);
        assert_eq!(
            pushed.tick.pending,
            Some(RemotePending {
                inflight: 2,
                mutations: 2,
                ..RemotePending::default()
            })
        );
        assert_eq!(driver.inflight_remote_push.len(), 2);
        let request_ids = trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .iter()
            .filter_map(|message| match message {
                ClientMessage::Mutation { request_id, .. } => Some(*request_id),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(request_ids, vec![0, 1]);
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn foreground_replay_applies_a_changed_subscription_before_retrying_a_rebase() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = documents_crdt_store("remote-rebase-yield.db");
        let first = Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": "srv1" }],
            "changes": [{
                "op": "put",
                "table": "documents",
                "rowId": "srv1",
                "plainHash": "plain:first",
                "fields": { "title": "first" },
            }],
            "crdt": [],
        }))
        .unwrap();
        {
            let mut state = trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.query_results.push_back(first);
            state.state_version = Some(StateVersion::initial());
        }
        store
            .remote_push_envelope_write("edit", 1, &replay_envelope_json("edit", 1), 1)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        driver
            .scope_write(RemoteScope {
                subscriptions: vec![RemoteSubscription {
                    pull_fn: "documents:list".to_owned(),
                    pull_args: serde_json::json!({}),
                    result_cache_key: None,
                    cursor: None,
                }],
            })
            .unwrap();
        let tables = driver.schema_table_names().unwrap();
        driver
            .ensure_live_subscription(&tables, false)
            .await
            .unwrap();
        driver.drive_remote_write_with_ingress().await.unwrap();

        let initial = driver
            .doc_push(
                "documents",
                "documents|row",
                storage::DirtyHeadToken {
                    first_commit_seq: 1,
                    updated_commit_seq: 1,
                },
            )
            .await
            .unwrap();
        assert_eq!(initial.tick.push_attempted, 1);

        let second = Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": "srv1" }],
            "changes": [{
                "op": "put",
                "table": "documents",
                "rowId": "srv1",
                "plainHash": "plain:second",
                "fields": { "title": "authoritative" },
            }],
            "crdt": [],
        }))
        .unwrap();
        let (request_id, query_id, start_version) = {
            let state = trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let request_id = state
                .sent
                .iter()
                .find_map(|message| match message {
                    ClientMessage::Mutation { request_id, .. } => Some(*request_id),
                    _ => None,
                })
                .expect("the first replay emitted a mutation");
            let query_id = state
                .sent
                .iter()
                .find_map(|message| match message {
                    ClientMessage::ModifyQuerySet { modifications, .. } => modifications
                        .iter()
                        .find_map(|modification| match modification {
                            QuerySetModification::Add(query) => Some(query.query_id),
                            QuerySetModification::Remove { .. } => None,
                        }),
                    _ => None,
                })
                .expect("the scope emitted a live query");
            (
                request_id,
                query_id,
                state
                    .state_version
                    .expect("the initial query transition has a version"),
            )
        };
        let end_version = StateVersion {
            ts: start_version
                .ts
                .succ()
                .expect("the test timestamp should advance"),
            ..start_version
        };
        {
            let mut state = trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            state.events.extend([
                TransportEvent::ServerMessage(ServerMessage::MutationResponse {
                    request_id,
                    result: rebase_push_result("edit").into(),
                    ts: Some(end_version.ts),
                    log_lines: LogLinesMessage(Vec::new()),
                }),
                TransportEvent::ServerMessage(ServerMessage::Transition {
                    start_version,
                    end_version,
                    modifications: vec![StateModification::QueryUpdated {
                        query_id,
                        value: second,
                        log_lines: LogLinesMessage(Vec::new()),
                        journal: None,
                    }],
                    client_clock_skew: None,
                    server_ts: None,
                }),
            ]);
            state.state_version = Some(end_version);
        }

        driver
            .receive_once_with_timeout(Duration::ZERO)
            .await
            .unwrap();
        assert!(
            !driver.replay_waiting_for_remote_write,
            "Convex settles the mutation only after the covering transition"
        );
        driver
            .receive_once_with_timeout(Duration::ZERO)
            .await
            .unwrap();
        assert!(driver.replay_waiting_for_remote_write);
        assert!(
            driver.remote_write_pending.is_empty(),
            "the actor yield happens after ingress but before the changed result is queued"
        );

        let pushed = driver
            .doc_push(
                "documents",
                "documents|row",
                storage::DirtyHeadToken {
                    first_commit_seq: 1,
                    updated_commit_seq: 1,
                },
            )
            .await
            .unwrap();

        assert_eq!(pushed.tick.push_attempted, 1);
        assert!(!driver.replay_waiting_for_remote_write);
        assert_eq!(driver.inflight_remote_push.len(), 1);
        let page = store
            .doc_page_read(&storage::ReadSpec {
                table: "documents".to_owned(),
                ..storage::ReadSpec::default()
            })
            .unwrap();
        assert_eq!(
            storage::testkit::parse_docs(&page)[0]["title"],
            "authoritative",
            "the changed subscription is durably projected before replay resumes"
        );
        assert_eq!(
            trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .sent
                .iter()
                .filter(|message| matches!(message, ClientMessage::Mutation { .. }))
                .count(),
            2
        );
    }

    #[test]
    fn replay_lane_does_not_settle_a_later_response_before_the_durable_front() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let store = test_store("remote-replay-reverse-response.db");
        store
            .remote_push_envelope_write("first", 1, &replay_envelope_json("first", 1), 1)
            .unwrap();
        store
            .remote_push_envelope_write("second", 2, &replay_envelope_json("second", 2), 2)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        let first = crate::push::decode_envelope(&replay_envelope_json("first", 1)).unwrap();
        let second = crate::push::decode_envelope(&replay_envelope_json("second", 2)).unwrap();
        let (first_send, first_result) = oneshot::channel();
        let (second_send, second_result) = oneshot::channel();
        driver.inflight_remote_push.extend([
            InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: Vec::new(),
                    envelope: Box::new(first),
                },
                result: first_result,
            },
            InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: Vec::new(),
                    envelope: Box::new(second),
                },
                result: second_result,
            },
        ]);

        second_send.send(applied_push_result("second")).unwrap();
        let tick = driver.remote_settlement_write().unwrap();

        assert!(!tick.has_observable_progress());
        assert_eq!(driver.inflight_remote_push.len(), 2);
        let queued = store.remote_push_envelope_read(2).unwrap();
        assert_eq!(queued.len(), 2);
        assert_eq!(
            crate::push::decode_envelope(&queued[0])
                .unwrap()
                .mutation_id,
            "first"
        );
        first_send.send(applied_push_result("first")).unwrap();
    }

    #[tokio::test]
    async fn changed_durable_prefix_drains_then_replays_without_deleting_local_work() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-live-prefix-change.db");
        store
            .remote_push_envelope_write("first", 1, &replay_envelope_json("first", 1), 1)
            .unwrap();
        store
            .remote_push_envelope_write("second", 2, &replay_envelope_json("second", 2), 2)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        // `second` models the window sent before a same-sequence legacy insertion changed the
        // durable prefix to `first, second`.
        let second = crate::push::decode_envelope(&replay_envelope_json("second", 2)).unwrap();
        let (second_send, second_result) = oneshot::channel();
        driver.inflight_remote_push.push_back(InflightRemotePush {
            kind: InflightRemotePushKind::Mutation {
                acknowledgements: Vec::new(),
                envelope: Box::new(second),
            },
            result: second_result,
        });

        let changed = driver.dispatch_ready_remote_pushes().await.unwrap();
        assert_eq!(changed.push_attempted, 0);
        assert!(driver.replay_inflight_discarding);
        assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 2);

        second_send.send(applied_push_result("second")).unwrap();
        let discarded = driver.remote_settlement_write().unwrap();
        assert!(!discarded.has_observable_progress());
        assert!(!driver.replay_inflight_discarding);
        assert!(driver.inflight_remote_push.is_empty());
        assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 2);

        let replayed = driver.dispatch_ready_remote_pushes().await.unwrap();
        assert_eq!(replayed.push_attempted, 2);
        assert_eq!(driver.inflight_remote_push.len(), 2);
        let replay_ids = driver
            .inflight_remote_push
            .iter()
            .filter_map(|inflight| match &inflight.kind {
                InflightRemotePushKind::Mutation { envelope, .. } => {
                    Some(envelope.replay_id.as_str())
                }
                InflightRemotePushKind::Blob | InflightRemotePushKind::Checkpoint { .. } => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(replay_ids, ["first", "second"]);
    }

    #[tokio::test]
    async fn changed_durable_prefix_counts_a_closed_suffix_as_drained() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-live-prefix-closed.db");
        store
            .remote_push_envelope_write("first", 1, &replay_envelope_json("first", 1), 1)
            .unwrap();
        store
            .remote_push_envelope_write("second", 2, &replay_envelope_json("second", 2), 2)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let second = crate::push::decode_envelope(&replay_envelope_json("second", 2)).unwrap();
        let (second_send, second_result) = oneshot::channel::<FunctionResult>();
        driver.inflight_remote_push.push_back(InflightRemotePush {
            kind: InflightRemotePushKind::Mutation {
                acknowledgements: Vec::new(),
                envelope: Box::new(second),
            },
            result: second_result,
        });

        driver.dispatch_ready_remote_pushes().await.unwrap();
        assert!(driver.replay_inflight_discarding);

        drop(second_send);
        let drained = driver.remote_settlement_write().unwrap();
        assert_eq!(drained, RemoteTick::default());
        assert!(!driver.replay_inflight_discarding);
        assert!(driver.inflight_remote_push.is_empty());
        assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 2);

        let replayed = driver.dispatch_ready_remote_pushes().await.unwrap();
        assert_eq!(replayed.push_attempted, 2);
        assert_eq!(driver.inflight_remote_push.len(), 2);
    }

    #[test]
    fn large_blob_staging_enqueues_every_chunk_without_waiting_for_a_response() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-blob-lane.db"),
            transport,
            SystemRemoteClock::default(),
        );
        let bytes = vec![7; crate::push::BLOB_CHUNK_BYTES * 2 + 1];

        let chunks = driver.stage_blob(&bytes, "blob-hash").unwrap();

        assert_eq!(chunks, 3);
        assert_eq!(driver.inflight_remote_push.len(), 3);
        assert!(driver
            .inflight_remote_push
            .iter()
            .all(|push| matches!(push.kind, InflightRemotePushKind::Blob)));
    }

    #[tokio::test]
    async fn pull_command_rescans_durable_pushes_after_an_idle_turn() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-pull-rescans-pushes.db");
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        driver.dispatch_ready_remote_pushes().await.unwrap();
        assert!(driver.push_queue_empty);

        store
            .remote_push_envelope_write("after-idle", 1, &replay_envelope_json("after-idle", 1), 1)
            .unwrap();

        let (_commands, receiver) = mpsc::channel(1);
        let (response, completed) = oneshot::channel();
        driver
            .run_command(RemoteCommand::PullOnce { response }, &receiver)
            .await
            .unwrap();
        let tick = completed.await.unwrap().unwrap();

        assert_eq!(tick.push_attempted, 1);
        assert_eq!(driver.inflight_remote_push.len(), 1);
        assert_eq!(
            trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .sent
                .iter()
                .filter(|message| matches!(message, ClientMessage::Mutation { .. }))
                .count(),
            1
        );
    }

    #[test]
    fn queued_remote_write_coalesces_to_the_newest_subscription_result() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-write-coalesce.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.remote_write_active = Some(ActiveRemoteWrite {
            future: Box::pin(future::pending()),
            pending: PendingRemoteWrite {
                checkpoint_responses: Vec::new(),
                crdt_changes: 0,
                pull_changes: 0,
                result: Some(FunctionResult::Value(Value::String("active".to_owned()))),
                subscription: "watch".to_owned(),
                write: empty_remote_write("watch"),
            },
        });
        for value in ["older", "newest"] {
            driver.stage_remote_write(PendingRemoteWrite {
                checkpoint_responses: Vec::new(),
                crdt_changes: 0,
                pull_changes: 0,
                result: Some(FunctionResult::Value(Value::String(value.to_owned()))),
                subscription: "watch".to_owned(),
                write: empty_remote_write("watch"),
            });
        }

        assert_eq!(
            driver.remote_write_order,
            VecDeque::from(["watch".to_owned()])
        );
        assert_eq!(
            driver
                .remote_write_pending
                .get("watch")
                .and_then(|pending| pending.result.as_ref()),
            Some(&FunctionResult::Value(Value::String("newest".to_owned())))
        );
    }

    #[test]
    fn changed_page_batch_is_staged_before_remote_write_starts() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-write-batch.db"),
            transport,
            SystemRemoteClock::default(),
        );
        for subscription in ["first", "second"] {
            driver.stage_remote_write(PendingRemoteWrite {
                checkpoint_responses: Vec::new(),
                crdt_changes: 0,
                pull_changes: 0,
                result: Some(FunctionResult::Value(Value::String(
                    subscription.to_owned(),
                ))),
                subscription: subscription.to_owned(),
                write: empty_remote_write(subscription),
            });
        }

        assert!(driver.remote_write_active.is_none());
        assert_eq!(
            driver.remote_write_order,
            VecDeque::from(["first".to_owned(), "second".to_owned()])
        );

        driver.start_next_remote_write();
        assert_eq!(
            driver
                .remote_write_active
                .as_ref()
                .map(|active| active.pending.subscription.as_str()),
            Some("first")
        );
        assert!(driver.remote_write_pending.contains_key("second"));
    }

    #[tokio::test]
    async fn rebase_barrier_clears_only_after_a_page_write_completes() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-rebase-write-barrier.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.replay_waiting_for_remote_write = true;
        driver.stage_remote_write(PendingRemoteWrite {
            checkpoint_responses: Vec::new(),
            crdt_changes: 0,
            pull_changes: 0,
            result: Some(FunctionResult::Value(Value::Null)),
            subscription: "watch".to_owned(),
            write: empty_remote_write("watch"),
        });

        driver.start_next_remote_write();
        assert!(driver.remote_write_active.is_some());
        assert!(
            driver.replay_waiting_for_remote_write,
            "starting storage work is not proof that the authoritative page committed"
        );

        driver.drive_remote_write_with_ingress().await.unwrap();
        assert!(driver.remote_write_active.is_none());
        assert!(
            !driver.replay_waiting_for_remote_write,
            "a successfully committed page write releases the retained replay"
        );
    }

    #[test]
    fn retained_replay_pauses_the_remote_write_lane() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-write-replay.db"),
            transport,
            SystemRemoteClock::default(),
        );
        let (_result_sender, result) = oneshot::channel();
        driver.inflight_remote_push.push_back(InflightRemotePush {
            kind: InflightRemotePushKind::Checkpoint {
                checkpoint_id: "checkpoint".to_owned(),
            },
            result,
        });
        driver.stage_remote_write(PendingRemoteWrite {
            checkpoint_responses: Vec::new(),
            crdt_changes: 0,
            pull_changes: 0,
            result: Some(FunctionResult::Value(Value::Null)),
            subscription: "watch".to_owned(),
            write: empty_remote_write("watch"),
        });
        driver.start_next_remote_write();

        assert!(driver.remote_write_active.is_none());
        assert!(driver.remote_write_pending.contains_key("watch"));
    }

    #[tokio::test]
    async fn foreground_replay_finishes_only_the_active_remote_write() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-write-priority.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.remote_write_active = Some(ActiveRemoteWrite {
            future: Box::pin(future::ready(Ok(empty_pull_result()))),
            pending: PendingRemoteWrite {
                checkpoint_responses: Vec::new(),
                crdt_changes: 0,
                pull_changes: 0,
                result: Some(FunctionResult::Value(Value::Null)),
                subscription: "active".to_owned(),
                write: empty_remote_write("active"),
            },
        });
        driver.stage_remote_write(PendingRemoteWrite {
            checkpoint_responses: Vec::new(),
            crdt_changes: 0,
            pull_changes: 0,
            result: Some(FunctionResult::Value(Value::Null)),
            subscription: "queued".to_owned(),
            write: empty_remote_write("queued"),
        });

        driver
            .finish_active_remote_write_before_replay()
            .await
            .unwrap();

        assert!(driver.remote_write_active.is_none());
        assert!(driver.remote_write_pending.contains_key("queued"));
        assert!(!driver.remote_write_paused);
    }

    #[tokio::test]
    async fn native_actor_accepts_scope_and_close_while_a_remote_write_is_active() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-write-command.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        let remote_write_release = Arc::new(Notify::new());
        let release = Arc::clone(&remote_write_release);
        driver.remote_write_active = Some(ActiveRemoteWrite {
            future: Box::pin(async move {
                release.notified().await;
                Ok(empty_pull_result())
            }),
            pending: PendingRemoteWrite {
                checkpoint_responses: Vec::new(),
                crdt_changes: 0,
                pull_changes: 0,
                result: Some(FunctionResult::Value(Value::Null)),
                subscription: "active".to_owned(),
                write: empty_remote_write("active"),
            },
        });

        let (commands, receiver) = mpsc::channel(2);
        let task = tokio::spawn(driver.run_with_observer(receiver, |_| {}));
        let (response, completed) = oneshot::channel();
        commands
            .send(RemoteCommand::ScopeWrite {
                scope: RemoteScope::default(),
                response,
            })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_millis(100), completed)
            .await
            .expect("scope update was hidden by active remote-write work")
            .unwrap()
            .unwrap();
        let (response, closed) = oneshot::channel();
        commands
            .send(RemoteCommand::Close { response })
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_millis(100), closed)
            .await
            .expect("close was hidden by active remote-write work")
            .unwrap()
            .unwrap();
        task.await.unwrap().unwrap();
        remote_write_release.notify_one();
    }

    #[tokio::test]
    async fn failed_reconnect_keeps_the_actor_alive_until_transport_recovers() {
        let trace = Arc::new(Mutex::new(TransportTrace {
            connect_failures: 1,
            events: VecDeque::from([TransportEvent::Closed("offline".to_owned())]),
            ..TransportTrace::default()
        }));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store("remote-reconnect-retry.db"),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let observed = Arc::new(Mutex::new(Vec::new()));
        let observed_ticks = Arc::clone(&observed);
        let (commands, receiver) = mpsc::channel(2);
        let task = tokio::spawn(driver.run_with_observer(receiver, move |tick| {
            observed_ticks
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(tick);
        }));

        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if observed
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .iter()
                    .any(|tick| tick.reconnected)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("actor did not recover after a transient reconnect failure");

        let (response, closed) = oneshot::channel();
        commands
            .send(RemoteCommand::Close { response })
            .await
            .unwrap();
        closed.await.unwrap().unwrap();
        task.await.unwrap().unwrap();
        let observed = observed
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert!(observed.iter().any(|tick| tick.connected == Some(false)));
        assert!(observed.iter().any(|tick| tick.connected == Some(true)));
        assert_eq!(
            trace
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .connects,
            2
        );
    }

    #[tokio::test]
    async fn native_actor_waits_for_socket_without_a_pull_command() {
        let path =
            std::env::temp_dir().join(format!("embedded-remote-{}.db", uuid::Uuid::new_v4()));
        let store = Arc::new(storage::EmbeddedStore::open(path.to_str().unwrap()).unwrap());
        let waited = Arc::new(Notify::new());
        let transport = WaitingTransport {
            waited: Arc::clone(&waited),
        };
        let config = RemoteConfig::new("https://example.convex.cloud".parse().unwrap());
        let mut driver =
            RemoteDriver::open_with_store(config, store, transport, SystemRemoteClock::default());
        driver.connected = true;

        let (commands, receiver) = mpsc::channel(1);
        let task = tokio::spawn(driver.run_with_observer(receiver, |_| {}));
        tokio::time::timeout(Duration::from_secs(1), waited.notified())
            .await
            .expect("native actor did not wait for socket ingress");

        let (response, completed) = oneshot::channel();
        commands
            .send(RemoteCommand::Close { response })
            .await
            .expect("native actor dropped its command receiver");
        completed
            .await
            .expect("native actor dropped the close response")
            .expect("native actor failed to close");
        task.await
            .expect("native actor task panicked")
            .expect("native actor exited with an error");
        for suffix in ["", "-wal", "-shm"] {
            std::fs::remove_file(path.with_file_name(format!(
                "{}{}",
                path.file_name().unwrap().to_string_lossy(),
                suffix
            )))
            .ok();
        }
    }

    #[tokio::test]
    async fn deferred_foreground_doc_push_runs_before_the_next_queued_remote_write() {
        let trace = Arc::new(Mutex::new(TransportTrace {
            auto_respond_to_mutations: true,
            mutation_settlements: VecDeque::from([applied_push_result("foreground")]),
            ..TransportTrace::default()
        }));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-foreground-priority.db");
        store
            .remote_push_envelope_write("foreground", 1, &replay_envelope_json("foreground", 1), 1)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            store,
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        driver.push_queue_empty = true;
        let actor_trace = Arc::clone(&driver.actor_trace);

        let remote_write_release = Arc::new(Notify::new());
        let release = Arc::clone(&remote_write_release);
        driver.remote_write_active = Some(ActiveRemoteWrite {
            future: Box::pin(async move {
                release.notified().await;
                Ok(empty_pull_result())
            }),
            pending: PendingRemoteWrite {
                checkpoint_responses: Vec::new(),
                crdt_changes: 0,
                pull_changes: 0,
                result: Some(FunctionResult::Value(Value::Null)),
                subscription: "active".to_owned(),
                write: empty_remote_write("active"),
            },
        });
        driver.stage_remote_write(PendingRemoteWrite {
            checkpoint_responses: Vec::new(),
            crdt_changes: 0,
            pull_changes: 0,
            result: Some(FunctionResult::Value(Value::Null)),
            subscription: "queued".to_owned(),
            write: empty_remote_write("queued"),
        });

        let (commands, receiver) = mpsc::channel(2);
        let task = tokio::spawn(driver.run_with_observer(receiver, |_| {}));

        let (doc_response, doc_completed) = oneshot::channel();
        commands
            .send(RemoteCommand::DocPush {
                table: "documents".to_owned(),
                local_document_id: "documents|row".to_owned(),
                token: storage::DirtyHeadToken {
                    first_commit_seq: 1,
                    updated_commit_seq: 1,
                },
                response: doc_response,
            })
            .await
            .unwrap();
        let (scope_response, scope_acked) = oneshot::channel();
        commands
            .send(RemoteCommand::ScopeWrite {
                scope: RemoteScope::default(),
                response: scope_response,
            })
            .await
            .unwrap();
        scope_acked.await.unwrap().unwrap();

        remote_write_release.notify_one();

        wait_for_actor_trace(
            &actor_trace,
            &[
                "remote_write",
                "mutation_response",
                "transition",
                "settlement",
                "remote_write",
            ],
            "the deferred foreground DocPush did not settle before the next queued remote write",
        )
        .await;

        let pushed = doc_completed.await.unwrap().unwrap();
        assert_eq!(pushed.tick.push_attempted, 1);

        let (response, closed) = oneshot::channel();
        commands
            .send(RemoteCommand::Close { response })
            .await
            .unwrap();
        closed.await.unwrap().unwrap();
        task.await.unwrap().unwrap();
    }

    #[test]
    fn crdt_rebase_retains_the_durable_envelope_without_early_acceptance() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let store = test_store("remote-crdt-rebase.db");
        store
            .remote_push_envelope_write("edit", 1, &crdt_envelope_json("edit", 1, 0), 1)
            .unwrap();
        store
            .remote_push_envelope_write("suffix", 2, &crdt_envelope_json("suffix", 2, 1), 2)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );

        let edit = crate::push::decode_envelope(&crdt_envelope_json("edit", 1, 0)).unwrap();
        let suffix = crate::push::decode_envelope(&crdt_envelope_json("suffix", 2, 1)).unwrap();
        let (edit_send, edit_result) = oneshot::channel();
        let (suffix_send, suffix_result) = oneshot::channel();
        driver.inflight_remote_push.extend([
            InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: Vec::new(),
                    envelope: Box::new(edit),
                },
                result: edit_result,
            },
            InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: Vec::new(),
                    envelope: Box::new(suffix),
                },
                result: suffix_result,
            },
        ]);

        edit_send.send(rebase_push_result("edit")).unwrap();
        let tick = driver.remote_settlement_write().unwrap();

        assert_eq!(tick.push_rebases, 1);
        assert_eq!(tick.push_accepted, 0);
        assert_eq!(tick.pushed, 0);

        assert_eq!(driver.inflight_remote_push.len(), 1);
        assert!(driver.replay_inflight_discarding);
        assert!(driver.replay_waiting_for_remote_write);

        suffix_send.send(rebase_push_result("suffix")).unwrap();
        let drained = driver.remote_settlement_write().unwrap();
        assert_eq!(drained, RemoteTick::default());
        assert!(driver.inflight_remote_push.is_empty());
        assert!(!driver.replay_inflight_discarding);

        let durable = store.remote_push_envelope_read(10).unwrap();
        assert_eq!(durable.len(), 2);
        let front = crate::push::decode_envelope(&durable[0]).unwrap();
        assert_eq!(front.mutation_id, "edit");
        assert_eq!(front.commit_seq, 1);
    }

    #[tokio::test]
    async fn conflict_drains_the_invalidated_inflight_window_before_dispatching_again() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-conflict-invalidates-window.db");
        store
            .remote_push_envelope_write("first", 1, &replay_envelope_json("first", 1), 1)
            .unwrap();
        store
            .remote_push_envelope_write("suffix", 2, &replay_envelope_json("suffix", 2), 2)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let first = crate::push::decode_envelope(&replay_envelope_json("first", 1)).unwrap();
        // This suffix models the already-sent CRDT request whose speculative base depended on
        // the front mutation. Its durable form remains authoritative and is intentionally not
        // rewritten while the original response is still in flight.
        let suffix = crate::push::decode_envelope(&crdt_envelope_json("suffix", 2, 1)).unwrap();
        let (first_send, first_result) = oneshot::channel();
        let (suffix_send, suffix_result) = oneshot::channel();
        driver.inflight_remote_push.extend([
            InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: Vec::new(),
                    envelope: Box::new(first),
                },
                result: first_result,
            },
            InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: Vec::new(),
                    envelope: Box::new(suffix),
                },
                result: suffix_result,
            },
        ]);

        first_send.send(conflict_push_result("first")).unwrap();
        let conflict = driver.remote_settlement_write().unwrap();

        assert_eq!(conflict.push_conflicts, 1);
        assert!(driver.replay_inflight_invalidated);
        assert_eq!(driver.inflight_remote_push.len(), 1);
        assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 1);

        let dispatched = driver.dispatch_ready_remote_pushes().await.unwrap();
        assert_eq!(dispatched.push_attempted, 0);
        assert_eq!(driver.inflight_remote_push.len(), 1);
        assert_eq!(sent_mutation_frames(&trace), 0);

        suffix_send.send(rebase_push_result("suffix")).unwrap();
        let rebase = driver.remote_settlement_write().unwrap();
        assert_eq!(rebase.push_rebases, 1);
        assert!(driver.replay_waiting_for_remote_write);
        assert!(!driver.replay_inflight_invalidated);
        assert!(driver.inflight_remote_push.is_empty());
        assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 1);
    }

    #[tokio::test]
    async fn rejected_replay_reuse_rotates_only_the_attempt_and_redispatches_after_the_suffix() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-replay-attempt-rotation.db");
        let front_json = replay_envelope_json("edit", 1);
        store
            .remote_push_envelope_write("edit", 1, &front_json, 1)
            .unwrap();
        store
            .remote_push_envelope_write("suffix", 2, &replay_envelope_json("suffix", 2), 2)
            .unwrap();
        let front = crate::push::decode_envelope(&front_json).unwrap();
        let logical_fingerprint = front.logical_fingerprint.clone();
        let suffix = crate::push::decode_envelope(&replay_envelope_json("suffix", 2)).unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        let (front_send, front_result) = oneshot::channel();
        let (suffix_send, suffix_result) = oneshot::channel();
        driver.inflight_remote_push.extend([
            InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: Vec::new(),
                    envelope: Box::new(front),
                },
                result: front_result,
            },
            InflightRemotePush {
                kind: InflightRemotePushKind::Mutation {
                    acknowledgements: Vec::new(),
                    envelope: Box::new(suffix),
                },
                result: suffix_result,
            },
        ]);

        front_send.send(mutation_reuse_result("rejected")).unwrap();
        let rotated = driver.remote_settlement_write().unwrap();
        assert_eq!(rotated, RemoteTick::default());
        assert!(!driver.replay_waiting_for_remote_write);
        assert!(driver.replay_inflight_discarding);
        assert_eq!(driver.inflight_remote_push.len(), 1);

        let durable = store.remote_push_envelope_read(10).unwrap();
        assert_eq!(durable.len(), 2);
        let rotated_front = crate::push::decode_envelope(&durable[0]).unwrap();
        assert_eq!(rotated_front.mutation_id, "edit");
        assert_ne!(rotated_front.replay_id, "edit");
        assert!(rotated_front.replay_id.starts_with("replay:"));
        assert_eq!(rotated_front.logical_fingerprint, logical_fingerprint);

        suffix_send.send(rebase_push_result("suffix")).unwrap();
        driver.remote_settlement_write().unwrap();
        assert!(driver.inflight_remote_push.is_empty());
        assert!(!driver.replay_inflight_discarding);
        assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 2);

        driver.connected = true;
        driver.push_queue_empty = false;
        let dispatched = driver.dispatch_ready_remote_pushes().await.unwrap();
        assert_eq!(dispatched.push_attempted, 2);
        assert_eq!(driver.inflight_remote_push.len(), 2);
        assert_eq!(sent_mutation_frames(&trace), 2);

        let InflightRemotePushKind::Mutation { envelope, .. } =
            &driver.inflight_remote_push[0].kind
        else {
            panic!("expected the rotated mutation at the replay window front")
        };
        assert_eq!(envelope.mutation_id, "edit");
        assert_eq!(envelope.replay_id, rotated_front.replay_id);
    }

    #[test]
    fn applied_replay_reuse_fails_closed_without_rotating_the_attempt() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let store = test_store("remote-applied-replay-reuse.db");
        let envelope_json = replay_envelope_json("edit", 1);
        store
            .remote_push_envelope_write("edit", 1, &envelope_json, 1)
            .unwrap();
        let envelope = crate::push::decode_envelope(&envelope_json).unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        let (send, result) = oneshot::channel();
        driver.inflight_remote_push.push_back(InflightRemotePush {
            kind: InflightRemotePushKind::Mutation {
                acknowledgements: Vec::new(),
                envelope: Box::new(envelope),
            },
            result,
        });

        send.send(mutation_reuse_result("applied")).unwrap();
        assert!(matches!(
            driver.remote_settlement_write(),
            Err(RemoteError::Protocol(message)) if message.contains("Mutation ID was reused")
        ));
        let durable = store.remote_push_envelope_read(1).unwrap();
        assert_eq!(
            crate::push::decode_envelope(&durable[0]).unwrap().replay_id,
            "edit"
        );
    }

    fn documents_crdt_schema() -> storage::StoreSchema {
        storage::StoreSchema {
            tables: vec![storage::TableDef {
                name: "documents".to_owned(),
                placement: storage::TablePlacement::Replicated,
                local_fields: Vec::new(),
                columns: Vec::new(),
                crdt_fields: vec![storage::CrdtFieldDef {
                    field: "body".to_owned(),
                    kind: storage::CrdtFieldKind::Text,
                }],
                indexes: Vec::new(),
            }],
        }
    }

    fn documents_crdt_store(name: &str) -> Arc<storage::EmbeddedStore> {
        let path = storage::testkit::tmp_path(name);
        let store = Arc::new(storage::EmbeddedStore::open(path.to_str().unwrap()).unwrap());
        store.setup(&documents_crdt_schema()).unwrap();
        store
    }

    fn documents_page_write(server_id: &str) -> storage::RemotePageWrite {
        storage::RemotePageWrite {
            subscription: "documents:list:{}".to_owned(),
            members: vec![storage::RemoteMember {
                table: "documents".to_owned(),
                server_document_id: server_id.to_owned(),
            }],
            projections: vec![storage::AuthoritativeRow {
                current_node_id: None,
                current_root_id: None,
                local_document_id: None,
                plain_hash: format!("plain:{server_id}"),
                projection_hash: format!("wire:{server_id}"),
                logical_clock: Some(1.0),
                received_time: 5,
                row: Some(format!(r#"{{"_id":"{server_id}","_creationTime":1}}"#)),
                server_document_id: server_id.to_owned(),
                table: "documents".to_owned(),
            }],
            crdt: Vec::new(),
            blobs: Vec::new(),
            cursor: Some("documents:1".to_owned()),
            received_time: 5,
            result: None,
        }
    }

    fn documents_crdt_advance_pull(
        server_id: &str,
        checkpoint: Vec<u8>,
        projection_hash: String,
    ) -> storage::RemotePageWrite {
        storage::RemotePageWrite {
            subscription: "documents:list:{}".to_owned(),
            members: vec![storage::RemoteMember {
                table: "documents".to_owned(),
                server_document_id: server_id.to_owned(),
            }],
            projections: Vec::new(),
            crdt: vec![storage::RemoteCrdtChange {
                table: "documents".to_owned(),
                document_id: server_id.to_owned(),
                field: "body".to_owned(),
                kind: storage::CrdtFieldKind::Text,
                epoch: 0,
                checkpoint_seq: 1,
                head_seq: 1,
                projection_hash,
                checkpoint: Some(checkpoint),
                updates: Vec::new(),
                checkpoint_request: None,
            }],
            blobs: Vec::new(),
            cursor: Some("documents:2".to_owned()),
            received_time: 6,
            result: None,
        }
    }

    fn crdt_row_envelope_json(
        mutation_id: &str,
        commit_seq: i64,
        base_seq: i64,
        row_id: &str,
        payload: Vec<u8>,
    ) -> String {
        serde_json::json!({
            "mutationId": mutation_id,
            "commitSeq": commit_seq,
            "clientRuntime": {
                "schemaHash": "local",
                "moduleGraphHash": "local",
                "protocolVersion": crate::config::EMBEDDED_PROTOCOL_VERSION,
            },
            "functionName": "documents:writeBody",
            "args": {},
            "resultHash": "result",
            "idPaths": [],
            "mutationTime": 1,
            "randomSeed": "seed",
            "localInserts": [],
            "localSchedules": [],
            "inserts": [],
            "argRefs": [],
            "reads": [],
            "schedules": [],
            "uploads": [],
            "afterImages": [],
            "crdt": [{
                "table": "documents",
                "rowId": row_id,
                "field": "body",
                "kind": "text",
                "baseSeq": base_seq,
                "projection": "abc",
                "projectionHash": "projection-hash",
                "payload": serde_json::Value::from(Value::Bytes(payload)),
            }],
            "revisionCheckpoints": [],
        })
        .to_string()
    }

    fn applied_push_result_with_crdt(
        mutation_id: &str,
        row_id: &str,
        head_seq: i64,
        projection_hash: &str,
    ) -> FunctionResult {
        FunctionResult::Value(Value::Object(BTreeMap::from([
            (
                "mutationId".to_owned(),
                Value::String(mutation_id.to_owned()),
            ),
            ("outcome".to_owned(), Value::String("applied".to_owned())),
            ("result".to_owned(), Value::Null),
            ("inserts".to_owned(), Value::Array(Vec::new())),
            ("schedules".to_owned(), Value::Array(Vec::new())),
            ("uploads".to_owned(), Value::Array(Vec::new())),
            ("revisions".to_owned(), Value::Array(Vec::new())),
            (
                "crdt".to_owned(),
                Value::Array(vec![Value::Object(BTreeMap::from([
                    ("table".to_owned(), Value::String("documents".to_owned())),
                    ("rowId".to_owned(), Value::String(row_id.to_owned())),
                    ("field".to_owned(), Value::String("body".to_owned())),
                    ("kind".to_owned(), Value::String("text".to_owned())),
                    ("headSeq".to_owned(), Value::Float64(head_seq as f64)),
                    (
                        "projectionHash".to_owned(),
                        Value::String(projection_hash.to_owned()),
                    ),
                ]))]),
            ),
            ("authoritative".to_owned(), Value::Array(Vec::new())),
        ])))
    }

    fn sent_mutation_frames(trace: &Arc<Mutex<TransportTrace>>) -> usize {
        trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .iter()
            .filter(|message| matches!(message, ClientMessage::Mutation { .. }))
            .count()
    }

    fn sent_mutation_request(trace: &Arc<Mutex<TransportTrace>>) -> serde_json::Value {
        let trace = trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let args = trace
            .sent
            .iter()
            .find_map(|message| match message {
                ClientMessage::Mutation { args, .. } => Some(args.get()),
                _ => None,
            })
            .expect("a mutation frame was sent");
        let args: serde_json::Value = serde_json::from_str(args).unwrap();
        args.as_array().unwrap()[0]["request"].clone()
    }

    #[tokio::test]
    async fn compatible_legacy_envelope_uses_current_protocol_only_on_the_wire() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-legacy-envelope-upgrade.db");
        let mut legacy: serde_json::Value =
            serde_json::from_str(&replay_envelope_json("legacy", 1)).unwrap();
        legacy["clientRuntime"]["protocolVersion"] =
            serde_json::json!(crate::config::EMBEDDED_PROTOCOL_VERSION - 1);
        legacy["clientRuntime"]["moduleGraphHash"] =
            serde_json::Value::String("legacy-modules".to_owned());
        let decoded_legacy = crate::push::decode_envelope(&legacy.to_string()).unwrap();
        store
            .remote_push_envelope_write("legacy", 1, &legacy.to_string(), 1)
            .unwrap();
        let mut config = RemoteConfig::new("https://example.convex.cloud".parse().unwrap());
        config
            .compatible_prior_runtimes
            .push(decoded_legacy.runtime.clone());
        let mut driver = RemoteDriver::open_with_store(
            config,
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let tick = driver.dispatch_ready_remote_pushes().await.unwrap();
        assert_eq!(tick.push_attempted, 1);
        let request = sent_mutation_request(&trace);
        assert_eq!(
            request["runtime"]["protocolVersion"].as_f64(),
            Some(crate::config::EMBEDDED_PROTOCOL_VERSION as f64)
        );
        assert_eq!(request["runtime"]["moduleGraphHash"], "local");
        assert_eq!(request["runtime"]["schemaHash"], "local");
        assert_eq!(request["mutationId"], "legacy");
        assert_eq!(request["replayId"], decoded_legacy.replay_id);
        assert_eq!(
            request["logicalFingerprint"],
            decoded_legacy.logical_fingerprint
        );

        let inflight = match &driver.inflight_remote_push[0].kind {
            InflightRemotePushKind::Mutation { envelope, .. } => envelope,
            InflightRemotePushKind::Blob | InflightRemotePushKind::Checkpoint { .. } => {
                panic!("expected an inflight mutation")
            }
        };
        assert_eq!(
            inflight.runtime.protocol_version,
            crate::config::EMBEDDED_PROTOCOL_VERSION
        );
        assert_eq!(inflight.mutation_id, "legacy");
        assert_eq!(inflight.replay_id, decoded_legacy.replay_id);
        assert_eq!(
            inflight.logical_fingerprint,
            decoded_legacy.logical_fingerprint
        );

        let durable = store.remote_push_envelope_read(1).unwrap();
        let durable = crate::push::decode_envelope(&durable[0]).unwrap();
        assert_eq!(
            durable.runtime.protocol_version,
            crate::config::EMBEDDED_PROTOCOL_VERSION - 1
        );
        assert_eq!(durable.runtime.module_graph_hash, "legacy-modules");
        assert_eq!(durable.replay_id, decoded_legacy.replay_id);
        assert_eq!(
            durable.logical_fingerprint,
            decoded_legacy.logical_fingerprint
        );
    }

    #[tokio::test]
    async fn incompatible_legacy_envelope_is_preserved_and_not_sent() {
        for (name, schema_hash, module_graph_hash) in [
            ("schema", "legacy-schema", "local"),
            ("modules", "local", "legacy-modules"),
        ] {
            let trace = Arc::new(Mutex::new(TransportTrace::default()));
            let transport = TraceTransport {
                trace: Arc::clone(&trace),
            };
            let store = test_store(&format!("remote-legacy-envelope-{name}.db"));
            let mut legacy: serde_json::Value =
                serde_json::from_str(&replay_envelope_json("legacy", 1)).unwrap();
            legacy["clientRuntime"]["protocolVersion"] =
                serde_json::json!(crate::config::EMBEDDED_PROTOCOL_VERSION - 1);
            legacy["clientRuntime"]["schemaHash"] =
                serde_json::Value::String(schema_hash.to_owned());
            legacy["clientRuntime"]["moduleGraphHash"] =
                serde_json::Value::String(module_graph_hash.to_owned());
            store
                .remote_push_envelope_write("legacy", 1, &legacy.to_string(), 1)
                .unwrap();
            let mut driver = RemoteDriver::open_with_store(
                RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
                Arc::clone(&store),
                transport,
                SystemRemoteClock::default(),
            );
            driver.connected = true;

            let error = driver.dispatch_ready_remote_pushes().await.unwrap_err();
            assert!(matches!(
                error,
                RemoteError::DeploymentMismatch(message)
                    if message.contains("local data was preserved")
                        && message.contains("legacy envelope was not upgraded")
            ));
            assert_eq!(sent_mutation_frames(&trace), 0);
            assert!(driver.inflight_remote_push.is_empty());
            let durable = store.remote_push_envelope_read(1).unwrap();
            assert_eq!(durable, vec![legacy.to_string()]);
        }
    }

    #[tokio::test]
    async fn declared_legacy_envelope_with_a_different_schema_is_preserved_and_not_sent() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-declared-legacy-schema-mismatch.db");
        let mut legacy: serde_json::Value =
            serde_json::from_str(&replay_envelope_json("legacy", 1)).unwrap();
        legacy["clientRuntime"]["protocolVersion"] =
            serde_json::json!(crate::config::EMBEDDED_PROTOCOL_VERSION - 1);
        legacy["clientRuntime"]["schemaHash"] =
            serde_json::Value::String("legacy-schema".to_owned());
        let decoded = crate::push::decode_envelope(&legacy.to_string()).unwrap();
        store
            .remote_push_envelope_write("legacy", 1, &legacy.to_string(), 1)
            .unwrap();
        let mut config = RemoteConfig::new("https://example.convex.cloud".parse().unwrap());
        config.compatible_prior_runtimes.push(decoded.runtime);
        let mut driver = RemoteDriver::open_with_store(
            config,
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let error = driver.dispatch_ready_remote_pushes().await.unwrap_err();
        assert!(matches!(error, RemoteError::DeploymentMismatch(_)));
        assert_eq!(sent_mutation_frames(&trace), 0);
        assert_eq!(
            store.remote_push_envelope_read(1).unwrap(),
            vec![legacy.to_string()]
        );
    }

    #[tokio::test]
    async fn same_protocol_envelope_from_a_different_module_graph_is_preserved_and_not_sent() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-same-protocol-module-mismatch.db");
        let mut queued: serde_json::Value =
            serde_json::from_str(&replay_envelope_json("queued", 1)).unwrap();
        queued["clientRuntime"]["moduleGraphHash"] =
            serde_json::Value::String("prior-modules".to_owned());
        store
            .remote_push_envelope_write("queued", 1, &queued.to_string(), 1)
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let error = driver.dispatch_ready_remote_pushes().await.unwrap_err();
        assert!(matches!(error, RemoteError::DeploymentMismatch(_)));
        assert_eq!(sent_mutation_frames(&trace), 0);
        assert_eq!(
            store.remote_push_envelope_read(1).unwrap(),
            vec![queued.to_string()]
        );
    }

    #[tokio::test]
    async fn declared_same_protocol_envelope_from_a_different_module_graph_is_sent() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = test_store("remote-declared-same-protocol-module-mismatch.db");
        let mut queued: serde_json::Value =
            serde_json::from_str(&replay_envelope_json("queued", 1)).unwrap();
        queued["clientRuntime"]["moduleGraphHash"] =
            serde_json::Value::String("prior-modules".to_owned());
        let decoded = crate::push::decode_envelope(&queued.to_string()).unwrap();
        store
            .remote_push_envelope_write("queued", 1, &queued.to_string(), 1)
            .unwrap();
        let mut config = RemoteConfig::new("https://example.convex.cloud".parse().unwrap());
        config.compatible_prior_runtimes.push(decoded.runtime);
        let mut driver = RemoteDriver::open_with_store(
            config,
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let tick = driver.dispatch_ready_remote_pushes().await.unwrap();
        assert_eq!(tick.push_attempted, 1);
        assert_eq!(sent_mutation_frames(&trace), 1);
        let request = sent_mutation_request(&trace);
        assert_eq!(request["runtime"]["moduleGraphHash"], "local");
        let durable = store.remote_push_envelope_read(1).unwrap();
        let durable = crate::push::decode_envelope(&durable[0]).unwrap();
        assert_eq!(durable.runtime.module_graph_hash, "prior-modules");
    }

    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn crdt_rebase_retry_redispatches_the_same_mutation_and_settles_without_a_duplicate_frame(
    ) {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = documents_crdt_store("remote-crdt-rebase-retry.db");

        store
            .remote_page_write(&documents_page_write("srv1"))
            .unwrap();
        let page = store
            .doc_page_read(&storage::ReadSpec {
                table: "documents".to_owned(),
                ..storage::ReadSpec::default()
            })
            .unwrap();
        let local_id = storage::testkit::parse_docs(&page)[0]["_id"]
            .as_str()
            .unwrap()
            .to_owned();

        let mint = documents_crdt_store("remote-crdt-rebase-mint.db");
        mint.crdt_field_intent_write(
            "documents",
            "seed",
            "body",
            storage::CrdtFieldKind::Text,
            &storage::CrdtOperation::TextSplice {
                index: 0,
                delete: 0,
                insert: "hi".to_owned(),
            },
            1,
        )
        .unwrap();
        let snapshot = mint
            .crdt_snapshot_read("documents", "seed")
            .unwrap()
            .into_iter()
            .find(|snapshot| snapshot.field == "body")
            .expect("the minted field carries a body snapshot");
        let payload = mint
            .crdt_field_intent_write(
                "documents",
                "seed",
                "body",
                storage::CrdtFieldKind::Text,
                &storage::CrdtOperation::TextSplice {
                    index: 2,
                    delete: 0,
                    insert: "!".to_owned(),
                },
                2,
            )
            .unwrap();

        store
            .remote_push_envelope_write(
                "edit",
                1,
                &crdt_row_envelope_json("edit", 1, 0, &local_id, payload.clone()),
                1,
            )
            .unwrap();

        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );

        let staged =
            crate::push::decode_envelope(&crdt_row_envelope_json("edit", 1, 0, &local_id, payload))
                .unwrap();
        let (edit_send, edit_result) = oneshot::channel();
        driver.inflight_remote_push.push_back(InflightRemotePush {
            kind: InflightRemotePushKind::Mutation {
                acknowledgements: Vec::new(),
                envelope: Box::new(staged),
            },
            result: edit_result,
        });
        edit_send.send(rebase_push_result("edit")).unwrap();
        let rebase = driver.remote_settlement_write().unwrap();
        assert_eq!(rebase.push_rebases, 1);
        assert!(driver.inflight_remote_push.is_empty());
        assert!(driver.replay_waiting_for_remote_write);
        assert_eq!(store.remote_push_envelope_read(10).unwrap().len(), 1);

        driver.stage_remote_write(PendingRemoteWrite {
            checkpoint_responses: Vec::new(),
            crdt_changes: 1,
            pull_changes: 0,
            result: Some(FunctionResult::Value(Value::Null)),
            subscription: "documents:list:{}".to_owned(),
            write: RemoteWrite::Page(documents_crdt_advance_pull(
                "srv1",
                snapshot.bytes.clone(),
                snapshot.projection_hash.clone(),
            )),
        });
        driver.start_next_remote_write();
        assert!(driver.replay_waiting_for_remote_write);
        driver.drive_remote_write_with_ingress().await.unwrap();
        assert_eq!(
            store
                .crdt_head_read("documents", &local_id, "body")
                .unwrap(),
            Some(1),
            "the authoritative pull advances the accepted CRDT head past the stale base"
        );
        assert!(!driver.replay_waiting_for_remote_write);
        driver.connected = true;
        driver.push_queue_empty = false;

        driver.dispatch_ready_remote_pushes().await.unwrap();

        assert_eq!(driver.inflight_remote_push.len(), 1);
        let InflightRemotePushKind::Mutation {
            envelope: prepared, ..
        } = &driver.inflight_remote_push[0].kind
        else {
            panic!("the retained CRDT mutation must be re-dispatched")
        };
        assert_eq!(prepared.mutation_id, "edit");
        assert_eq!(prepared.commit_seq, 1);
        assert_eq!(prepared.crdt.len(), 1);
        assert_eq!(
            prepared.crdt[0].base_seq, 1,
            "the retried effect rebases onto the pulled accepted head, not the stale base"
        );
        let prepared_hash = prepared.crdt[0].projection_hash.clone();
        let prepared_row_id = prepared.crdt[0].row_id.clone();
        assert_eq!(
            sent_mutation_frames(&trace),
            1,
            "re-dispatch sends exactly one mutation frame for the retained envelope"
        );
        assert_eq!(
            store
                .crdt_head_read("documents", &local_id, "body")
                .unwrap(),
            Some(1),
            "the accepted head does not advance on re-dispatch, only at settlement"
        );

        let request_id = trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .iter()
            .find_map(|message| match message {
                ClientMessage::Mutation { request_id, .. } => Some(*request_id),
                _ => None,
            })
            .expect("re-dispatch emits a mutation frame");
        trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .events
            .extend(covering_mutation_events(
                request_id,
                applied_push_result_with_crdt("edit", &prepared_row_id, 2, &prepared_hash),
            ));

        driver
            .receive_once_with_timeout(Duration::ZERO)
            .await
            .unwrap();
        driver
            .receive_once_with_timeout(Duration::ZERO)
            .await
            .unwrap();

        assert!(
            driver.inflight_remote_push.is_empty(),
            "the applied settlement drains the retained envelope from the inflight window"
        );
        assert!(
            store.remote_push_envelope_read(10).unwrap().is_empty(),
            "the durable envelope is removed once the retry settles applied"
        );
        assert_eq!(
            store
                .crdt_head_read("documents", &local_id, "body")
                .unwrap(),
            Some(2),
            "the accepted head advances by exactly the acknowledged payload at settlement"
        );
        assert_eq!(
            sent_mutation_frames(&trace),
            1,
            "no duplicate mutation frame is sent beyond the single legitimate re-dispatch"
        );
    }

    #[tokio::test]
    async fn applied_crdt_replay_drains_after_pull_already_observed_the_accepted_head() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = documents_crdt_store("remote-crdt-applied-replay-observed.db");
        store
            .remote_page_write(&documents_page_write("srv1"))
            .unwrap();
        let local_id = storage::testkit::parse_docs(
            &store
                .doc_page_read(&storage::ReadSpec {
                    table: "documents".to_owned(),
                    ..storage::ReadSpec::default()
                })
                .unwrap(),
        )[0]["_id"]
            .as_str()
            .unwrap()
            .to_owned();

        let mint = documents_crdt_store("remote-crdt-applied-replay-mint.db");
        mint.crdt_field_intent_write(
            "documents",
            "seed",
            "body",
            storage::CrdtFieldKind::Text,
            &storage::CrdtOperation::TextSplice {
                index: 0,
                delete: 0,
                insert: "hi".to_owned(),
            },
            1,
        )
        .unwrap();
        let payload = mint
            .crdt_field_intent_write(
                "documents",
                "seed",
                "body",
                storage::CrdtFieldKind::Text,
                &storage::CrdtOperation::TextSplice {
                    index: 2,
                    delete: 0,
                    insert: "!".to_owned(),
                },
                2,
            )
            .unwrap();
        let accepted = mint
            .crdt_snapshot_read("documents", "seed")
            .unwrap()
            .into_iter()
            .find(|snapshot| snapshot.field == "body")
            .expect("the accepted snapshot includes the queued payload");

        store
            .remote_push_envelope_write(
                "edit",
                1,
                &crdt_row_envelope_json("edit", 1, 0, &local_id, payload),
                1,
            )
            .unwrap();
        store
            .remote_page_write(&documents_crdt_advance_pull(
                "srv1",
                accepted.bytes,
                accepted.projection_hash.clone(),
            ))
            .unwrap();

        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        driver.dispatch_ready_remote_pushes().await.unwrap();
        let InflightRemotePushKind::Mutation {
            envelope: prepared, ..
        } = &driver.inflight_remote_push[0].kind
        else {
            panic!("the retained mutation must be dispatched")
        };
        assert_eq!(prepared.crdt[0].base_seq, 1);
        assert_eq!(prepared.crdt[0].projection_hash, accepted.projection_hash);
        let row_id = prepared.crdt[0].row_id.clone();
        let request_id = trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .sent
            .iter()
            .find_map(|message| match message {
                ClientMessage::Mutation { request_id, .. } => Some(*request_id),
                _ => None,
            })
            .expect("dispatch emits one mutation frame");
        trace
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .events
            .extend(covering_mutation_events(
                request_id,
                applied_push_result_with_crdt("edit", &row_id, 1, &accepted.projection_hash),
            ));

        driver
            .receive_once_with_timeout(Duration::ZERO)
            .await
            .unwrap();
        driver
            .receive_once_with_timeout(Duration::ZERO)
            .await
            .unwrap();

        assert!(store.remote_push_envelope_read(10).unwrap().is_empty());
        assert_eq!(
            store
                .crdt_head_read("documents", &local_id, "body")
                .unwrap(),
            Some(1),
            "an idempotent replay must not invent a second accepted CRDT sequence"
        );
    }

    fn documents_live_crdt_result(server_id: &str, head_seq: i64, projection_hash: &str) -> Value {
        Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": server_id }],
            "changes": [],
            "crdt": [{
                "table": "documents",
                "rowId": server_id,
                "field": "body",
                "kind": "text",
                "epoch": 0,
                "checkpoint": { "id": "cp", "seq": head_seq, "bytes": 3, "hash": "cp-hash" },
                "headSeq": head_seq,
                "projectionHash": projection_hash,
            }],
        }))
        .unwrap()
    }

    fn documents_checkpoint_result(
        server_id: &str,
        checkpoint_id: &str,
        seq: i64,
        checkpoint: &[u8],
        projection_hash: &str,
    ) -> Value {
        Value::try_from(serde_json::json!({
                "members": [{ "table": "documents", "rowId": server_id }],
                "changes": [],
                "crdt": [{
                    "table": "documents",
                    "rowId": server_id,
                    "field": "body",
                    "kind": "text",
                    "epoch": 0,
                    "checkpoint": {
                        "id": checkpoint_id,
                        "seq": seq,
                        "bytes": checkpoint.len(),
                        "hash": super::sha256_hex(checkpoint),
                    },
                    "headSeq": seq,
                    "projectionHash": projection_hash,
                }],
        }))
        .unwrap()
    }

    fn checkpoint_page(
        checkpoint_id: &str,
        seq: i64,
        checkpoint: &[u8],
        chunks: &serde_json::Value,
        continue_cursor: Option<&str>,
        is_done: bool,
    ) -> Value {
        Value::try_from(serde_json::json!({
                "checkpoint": {
                    "id": checkpoint_id,
                    "seq": seq,
                    "bytes": checkpoint.len(),
                    "hash": super::sha256_hex(checkpoint),
                },
                "headSeq": seq,
                "chunks": chunks,
                "payloads": [],
                "continueCursor": continue_cursor,
                "isDone": is_done,
        }))
        .unwrap()
    }

    /// Once payload deletion has advanced A through B to C, resuming A may observe that its immutable tail
    /// is gone. The stale outcome must discard only A's partial bytes, refresh the live query, and
    /// stage C; it must not enter `last_failed_result` or repeatedly request A.
    #[tokio::test]
    async fn a_stale_checkpoint_restarts_from_the_live_checkpoint() {
        let a = [1u8, 2, 3, 4];
        let c = [5u8, 6, 7];
        let result_a = documents_checkpoint_result("srv1", "checkpoint-a", 1, &a, "projection-a");
        let result_c = documents_checkpoint_result("srv1", "checkpoint-c", 3, &c, "projection-c");
        let trace = Arc::new(Mutex::new(TransportTrace {
            query_results: VecDeque::from([
                result_c.clone(),
                checkpoint_page(
                    "checkpoint-a",
                    1,
                    &a,
                    &serde_json::json!([{
                        "ordinal": 0,
                        "bytes": { "$bytes": "AQI=" },
                        "hash": super::sha256_hex(&a[..2]),
                    }]),
                    Some("chunk:0"),
                    false,
                ),
                Value::try_from(serde_json::json!({ "kind": "stale" })).unwrap(),
                checkpoint_page(
                    "checkpoint-c",
                    3,
                    &c,
                    &serde_json::json!([{
                        "ordinal": 0,
                        "bytes": { "$bytes": "BQYH" },
                        "hash": super::sha256_hex(&c),
                    }]),
                    None,
                    true,
                ),
            ]),
            state_version: Some(StateVersion::initial()),
            ..TransportTrace::default()
        }));
        let transport = TraceTransport { trace };
        let store = documents_crdt_store("remote-stale-checkpoint-restart.db");
        store
            .remote_page_write(&documents_page_write("srv1"))
            .unwrap();
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            store,
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        let descriptor = RemoteSubscription {
            pull_fn: "documents:list".to_owned(),
            pull_args: serde_json::json!({}),
            result_cache_key: None,
            cursor: None,
        };
        let key = super::remote_subscription_key(&descriptor).unwrap();
        let subscriber_id = driver.base.subscribe(
            RemoteFunction::parse(&descriptor.pull_fn)
                .unwrap()
                .into_udf_path(),
            crate::pull::args(
                &driver.config.runtime,
                &descriptor.pull_fn,
                &descriptor.pull_args,
            )
            .unwrap(),
        );
        driver.scope.subscriptions.push(descriptor.clone());
        driver.pull_subscriptions.push(PullSubscription {
            last_result: None,
            last_failed_result: None,
            key: key.clone(),
            subscriber_id,
            cursor: None,
        });

        let tick = driver
            .enqueue_pull_result(FunctionResult::Value(result_a), &key)
            .await
            .unwrap();
        assert_eq!(tick.pull_diagnostics, 0);
        assert!(
            driver.pull_subscriptions[0].last_failed_result.is_none(),
            "a stale retained prefix is a restart signal, not a quarantined manifest"
        );
        let staged = driver
            .remote_write_pending
            .get(&key)
            .expect("the refreshed C manifest should be staged");
        assert_eq!(
            staged.result.as_ref(),
            Some(&FunctionResult::Value(result_c))
        );
        let RemoteWrite::Page(write) = &staged.write else {
            panic!("expected a staged page write");
        };
        assert_eq!(write.crdt[0].checkpoint_seq, 3);
    }

    /// A retained live manifest whose CRDT prefix the client can never reconcile — the production
    /// shape after the component tables were wiped, where the field head advances but the checkpoint
    /// history no longer exists — must be reported once and then held, not re-attempted on every pull
    /// tick. The pre-fix driver returned this permanent failure straight out of `pull()`, so each
    /// tick re-issued a fresh one-shot checkpoint pull (~9 `embedded:pull`/second in prod) that never
    /// converged. This pins the terminal-diagnostic gate.
    #[tokio::test]
    #[allow(clippy::too_many_lines)]
    async fn an_unsatisfiable_live_manifest_is_reported_once_and_not_re_attempted() {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport {
            trace: Arc::clone(&trace),
        };
        let store = documents_crdt_store("remote-unsatisfiable-manifest.db");
        store
            .remote_page_write(&documents_page_write("srv1"))
            .unwrap();
        let page = store
            .doc_page_read(&storage::ReadSpec {
                table: "documents".to_owned(),
                ..storage::ReadSpec::default()
            })
            .unwrap();
        let local_id = storage::testkit::parse_docs(&page)[0]["_id"]
            .as_str()
            .unwrap()
            .to_owned();

        let mint = documents_crdt_store("remote-unsatisfiable-mint.db");
        mint.crdt_field_intent_write(
            "documents",
            "seed",
            "body",
            storage::CrdtFieldKind::Text,
            &storage::CrdtOperation::TextSplice {
                index: 0,
                delete: 0,
                insert: "hi".to_owned(),
            },
            1,
        )
        .unwrap();
        let snapshot = mint
            .crdt_snapshot_read("documents", "seed")
            .unwrap()
            .into_iter()
            .find(|snapshot| snapshot.field == "body")
            .expect("the minted field carries a body snapshot");
        store
            .remote_page_write(&documents_crdt_advance_pull(
                "srv1",
                snapshot.bytes.clone(),
                snapshot.projection_hash.clone(),
            ))
            .unwrap();
        assert_eq!(
            store
                .crdt_head_read("documents", &local_id, "body")
                .unwrap(),
            Some(1),
            "the warm client starts with an accepted CRDT head",
        );

        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let subscription = RemoteSubscription {
            pull_fn: "documents:list".to_owned(),
            pull_args: serde_json::json!({}),
            result_cache_key: None,
            cursor: None,
        };
        let key = super::remote_subscription_key(&subscription).unwrap();
        let subscriber_id = driver.base.subscribe(
            crate::protocol::pull_function().unwrap().into_udf_path(),
            crate::pull::args(
                &driver.config.runtime,
                &subscription.pull_fn,
                &subscription.pull_args,
            )
            .unwrap(),
        );
        driver.scope = RemoteScope {
            subscriptions: vec![subscription],
        };
        driver.pull_subscriptions.push(PullSubscription {
            last_result: None,
            last_failed_result: None,
            key: key.clone(),
            subscriber_id,
            cursor: None,
        });

        let result =
            FunctionResult::Value(documents_live_crdt_result("srv1", 1, "irreconcilable-hash"));

        let first = driver
            .enqueue_pull_result(result.clone(), &key)
            .await
            .expect("a permanent apply failure must not surface as a driver error");
        assert_eq!(
            first.pull_diagnostics, 1,
            "the first unsatisfiable manifest is reported exactly once",
        );
        assert!(
            driver.remote_write_pending.is_empty(),
            "a failed manifest stages no projection and retains prior accepted state",
        );

        let second = driver
            .enqueue_pull_result(result.clone(), &key)
            .await
            .expect("re-delivery of the same manifest must stay a no-op");
        assert_eq!(
            second.pull_diagnostics, 0,
            "an unchanged failed manifest is held, not re-attempted every tick",
        );
        assert_eq!(
            second,
            crate::RemoteTick::default(),
            "no work repeats on re-delivery"
        );

        assert_eq!(
            store
                .crdt_head_read("documents", &local_id, "body")
                .unwrap(),
            Some(1),
            "the accepted CRDT head is left untouched by the unsatisfiable manifest",
        );
    }

    fn result_driver(
        name: &str,
    ) -> RemoteDriver<TraceTransport, Arc<storage::EmbeddedStore>, SystemRemoteClock> {
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            test_store(name),
            transport,
            SystemRemoteClock::default(),
        );
        driver.scope = RemoteScope {
            subscriptions: vec![RemoteSubscription {
                pull_fn: "stats:list".to_owned(),
                pull_args: serde_json::json!({ "owner": "a" }),
                result_cache_key: Some("ts-authoritative-stats-key".to_owned()),
                cursor: None,
            }],
        };
        driver
    }

    fn live_result_value(skeleton: &serde_json::Value, rows: &serde_json::Value) -> Value {
        Value::try_from(serde_json::json!({
            "members": [],
            "changes": [],
            "crdt": [],
            "result": skeleton,
            "resultRows": rows,
        }))
        .unwrap()
    }

    fn assemble_result_pull(
        driver: &mut RemoteDriver<TraceTransport, Arc<storage::EmbeddedStore>, SystemRemoteClock>,
        value: Value,
    ) -> storage::RemotePageWrite {
        let key = super::remote_subscription_key(&driver.scope.subscriptions[0]).unwrap();
        let page = crate::pull::decode(value.clone()).unwrap();
        let prepared = driver
            .prepare_remote_write(&page, Vec::new(), FunctionResult::Value(value), &key)
            .unwrap();
        let RemoteWrite::Page(pull) = prepared.write else {
            panic!("a live pull prepares a page write");
        };
        pull
    }

    #[tokio::test]
    async fn a_live_pull_result_writes_a_retained_entry_inside_the_page_transaction() {
        let mut driver = result_driver("remote-result-write.db");
        let pull = assemble_result_pull(
            &mut driver,
            live_result_value(
                &serde_json::json!({ "latest": null, "total": 42 }),
                &serde_json::json!([{ "path": "/latest", "table": "documents", "rowId": "j57" }]),
            ),
        );
        let entry = *pull
            .result
            .clone()
            .expect("the page carries a result entry");
        driver.store().remote_page_write(&pull).unwrap();

        let stored = driver.store().result_read(&entry.key).unwrap().unwrap();
        assert_eq!(stored, entry);
        assert_eq!(
            stored.key, "ts-authoritative-stats-key",
            "the TS-authoritative cache key is stored verbatim, not re-derived Rust-side",
        );
        assert_eq!(stored.function, "stats:list");
        let skeleton: serde_json::Value = serde_json::from_slice(&stored.skeleton).unwrap();
        assert_eq!(
            skeleton,
            serde_json::json!({ "latest": null, "total": 42.0 })
        );
        let paths: serde_json::Value = serde_json::from_slice(&stored.paths).unwrap();
        assert_eq!(
            paths,
            serde_json::json!([{ "path": "/latest", "rowId": "j57", "table": "documents" }])
        );
    }

    #[tokio::test]
    async fn re_delivering_the_same_skeleton_hash_is_a_zero_write_skip() {
        let mut driver = result_driver("remote-result-skip.db");
        let value = live_result_value(
            &serde_json::json!({ "latest": null, "total": 42 }),
            &serde_json::json!([{ "path": "/latest", "table": "documents", "rowId": "j57" }]),
        );
        let pull = assemble_result_pull(&mut driver, value.clone());
        let entry = *pull.result.clone().unwrap();
        driver.store().remote_page_write(&pull).unwrap();

        let mut replay = pull.clone();
        let mut later = entry.clone();
        later.clock = 999.0;
        replay.result = Some(Box::new(later));
        driver.store().remote_page_write(&replay).unwrap();

        let stored = driver.store().result_read(&entry.key).unwrap().unwrap();
        assert_eq!(
            stored, entry,
            "a matching skeleton hash skips the write, leaving the original clock intact",
        );
    }

    #[tokio::test]
    async fn a_paths_only_change_still_writes_because_the_hash_covers_paths() {
        let mut driver = result_driver("remote-result-paths-only.db");
        let first = assemble_result_pull(
            &mut driver,
            live_result_value(
                &serde_json::json!({ "latest": null, "total": 42 }),
                &serde_json::json!([{ "path": "/latest", "table": "documents", "rowId": "j57" }]),
            ),
        );
        let first_entry = *first.result.clone().unwrap();
        driver.store().remote_page_write(&first).unwrap();

        let second = assemble_result_pull(
            &mut driver,
            live_result_value(
                &serde_json::json!({ "latest": null, "total": 42 }),
                &serde_json::json!([{ "path": "/latest", "table": "documents", "rowId": "j99" }]),
            ),
        );
        let second_entry = *second.result.clone().unwrap();
        assert_eq!(
            first_entry.key, second_entry.key,
            "the same subscription keys the same entry",
        );
        assert_eq!(
            first_entry.skeleton, second_entry.skeleton,
            "the skeleton bytes are identical across the two pulls",
        );
        assert_ne!(
            first_entry.skeleton_hash, second_entry.skeleton_hash,
            "a paths-only change moves the skeleton hash",
        );
        driver.store().remote_page_write(&second).unwrap();

        let stored = driver
            .store()
            .result_read(&first_entry.key)
            .unwrap()
            .unwrap();
        let paths: serde_json::Value = serde_json::from_slice(&stored.paths).unwrap();
        assert_eq!(
            paths,
            serde_json::json!([{ "path": "/latest", "rowId": "j99", "table": "documents" }]),
            "the paths-only change is durably applied, not skipped",
        );
    }

    #[tokio::test]
    async fn a_plain_only_pull_writes_no_results_row() {
        let mut driver = result_driver("remote-result-plain-only.db");
        let value = Value::try_from(serde_json::json!({
            "members": [],
            "changes": [],
            "crdt": [],
        }))
        .unwrap();
        let pull = assemble_result_pull(&mut driver, value);
        assert!(
            pull.result.is_none(),
            "a plain-only pull assembles no entry"
        );

        let key = driver.scope.subscriptions[0]
            .result_cache_key
            .clone()
            .unwrap();
        driver.store().remote_page_write(&pull).unwrap();
        assert_eq!(driver.store().result_read(&key).unwrap(), None);
    }

    #[tokio::test]
    async fn a_page_rollback_strands_no_results_row() {
        let mut driver = result_driver("remote-result-rollback.db");
        let pull = assemble_result_pull(
            &mut driver,
            live_result_value(
                &serde_json::json!({ "latest": null, "total": 42 }),
                &serde_json::json!([{ "path": "/latest", "table": "documents", "rowId": "j57" }]),
            ),
        );
        let entry = *pull.result.clone().unwrap();

        storage::testkit::fail_next_commit();
        assert!(driver.store().remote_page_write(&pull).is_err());
        assert_eq!(
            driver.store().result_read(&entry.key).unwrap(),
            None,
            "the rolled-back page leaves no retained entry",
        );
    }

    fn point_get_page(server_id: &str, with_member: bool) -> Value {
        let members = if with_member {
            serde_json::json!([{ "table": "documents", "rowId": server_id }])
        } else {
            serde_json::json!([])
        };
        Value::try_from(serde_json::json!({
            "members": members,
            "changes": [{
                "op": "put",
                "table": "documents",
                "rowId": server_id,
                "plainHash": format!("plain:{server_id}"),
                "fields": { "body": "hello" },
            }],
            "crdt": [],
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn a_result_channel_only_repull_retains_the_disclosed_point_row() {
        let store = documents_crdt_store("remote-point-get-observe.db");
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;
        let subscription = RemoteSubscription {
            pull_fn: "documents:get".to_owned(),
            pull_args: serde_json::json!({ "id": "srv1" }),
            result_cache_key: Some("documents:get:srv1".to_owned()),
            cursor: None,
        };
        let key = super::remote_subscription_key(&subscription).unwrap();
        let subscriber_id = driver.base.subscribe(
            crate::protocol::pull_function().unwrap().into_udf_path(),
            crate::pull::args(
                &driver.config.runtime,
                &subscription.pull_fn,
                &subscription.pull_args,
            )
            .unwrap(),
        );
        driver.scope = RemoteScope {
            subscriptions: vec![subscription],
        };
        driver.pull_subscriptions.push(PullSubscription {
            last_result: None,
            last_failed_result: None,
            key: key.clone(),
            subscriber_id,
            cursor: None,
        });

        let v1 = Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": "srv1" }],
            "changes": [{ "op": "put", "table": "documents", "rowId": "srv1", "plainHash": "plain:srv1", "fields": { "title": "t", "body": "seed" } }],
            "crdt": [],
            "result": null,
            "resultRows": [{ "path": "", "table": "documents", "rowId": "srv1" }],
        })).unwrap();
        let pull1 = assemble_result_pull(&mut driver, v1.clone());
        driver.store().remote_page_write(&pull1).unwrap();
        let local_id = driver
            .store()
            .id_local_read("documents", "srv1")
            .unwrap()
            .expect("the first pull materializes the disclosed row");
        if let Some(active) = driver
            .pull_subscriptions
            .iter_mut()
            .find(|active| active.key == key)
        {
            active.last_result = Some(FunctionResult::Value(v1));
        }

        let v2 = Value::try_from(serde_json::json!({
            "members": [],
            "changes": [{ "op": "put", "table": "documents", "rowId": "srv1", "plainHash": "plain:srv1", "fields": { "title": "t", "body": "seed" } }],
            "crdt": [],
            "result": null,
            "resultRows": [{ "path": "", "table": "documents", "rowId": "srv1" }],
        })).unwrap();
        let pull2 = assemble_result_pull(&mut driver, v2);
        assert!(
            pull2.members.is_empty(),
            "the re-pull discloses the row only through the result channel",
        );
        driver.store().remote_page_write(&pull2).unwrap();

        let page = driver
            .store()
            .doc_page_read(&storage::ReadSpec {
                table: "documents".to_owned(),
                ..storage::ReadSpec::default()
            })
            .unwrap();
        let docs = storage::testkit::parse_docs(&page);
        assert!(
            docs.iter()
                .any(|doc| doc["_id"].as_str() == Some(&local_id)),
            "a result-channel-only re-pull must retain the disclosed row instead of deleting it",
        );
    }

    #[tokio::test]
    async fn a_first_point_get_page_materializes_a_non_local_member_with_a_root_skeleton() {
        let store = documents_crdt_store("remote-point-get-first-pull.db");
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let subscription = RemoteSubscription {
            pull_fn: "documents:get".to_owned(),
            pull_args: serde_json::json!({ "id": "srv1" }),
            result_cache_key: Some("documents:get:srv1".to_owned()),
            cursor: None,
        };
        driver.scope = RemoteScope {
            subscriptions: vec![subscription],
        };

        let value = Value::try_from(serde_json::json!({
            "members": [{ "table": "documents", "rowId": "srv1" }],
            "changes": [{
                "op": "put",
                "table": "documents",
                "rowId": "srv1",
                "plainHash": "plain:srv1",
                "fields": { "title": "t", "body": "seed" },
            }],
            "crdt": [],
            "result": null,
            "resultRows": [{ "path": "", "table": "documents", "rowId": "srv1" }],
        }))
        .unwrap();

        let pull = assemble_result_pull(&mut driver, value);
        assert_eq!(pull.members.len(), 1);
        assert_eq!(
            pull.projections.len(),
            1,
            "first pull discloses the member row"
        );
        driver.store().remote_page_write(&pull).unwrap();
        assert!(
            driver
                .store()
                .id_local_read("documents", "srv1")
                .unwrap()
                .is_some(),
            "the point member materializes on the first pull",
        );
    }

    #[tokio::test]
    async fn a_member_reapplies_its_missing_projection_even_when_the_change_repeats_the_accepted_hash(
    ) {
        let store = documents_crdt_store("remote-member-filtered-projection.db");
        let trace = Arc::new(Mutex::new(TransportTrace::default()));
        let transport = TraceTransport { trace };
        let mut driver = RemoteDriver::open_with_store(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            Arc::clone(&store),
            transport,
            SystemRemoteClock::default(),
        );
        driver.connected = true;

        let subscription = RemoteSubscription {
            pull_fn: "documents:get".to_owned(),
            pull_args: serde_json::json!({ "id": "srv1" }),
            result_cache_key: None,
            cursor: None,
        };
        let key = super::remote_subscription_key(&subscription).unwrap();
        let subscriber_id = driver.base.subscribe(
            crate::protocol::pull_function().unwrap().into_udf_path(),
            crate::pull::args(
                &driver.config.runtime,
                &subscription.pull_fn,
                &subscription.pull_args,
            )
            .unwrap(),
        );
        driver.scope = RemoteScope {
            subscriptions: vec![subscription],
        };
        driver.pull_subscriptions.push(PullSubscription {
            last_result: Some(FunctionResult::Value(point_get_page("srv1", false))),
            last_failed_result: None,
            key,
            subscriber_id,
            cursor: None,
        });

        let pull = assemble_result_pull(&mut driver, point_get_page("srv1", true));
        assert_eq!(pull.members.len(), 1, "the page discloses the point member");
        assert_eq!(
            pull.projections.len(),
            1,
            "a member edge keeps its projection even when the change repeats the accepted plain hash",
        );

        driver.store().remote_page_write(&pull).unwrap();
        assert!(
            driver
                .store()
                .id_local_read("documents", "srv1")
                .unwrap()
                .is_some(),
            "the disclosed member materializes locally instead of wedging the page",
        );

        let steady = assemble_result_pull(&mut driver, point_get_page("srv1", true));
        assert_eq!(
            steady.projections.len(),
            0,
            "once the member is disclosed locally the unchanged projection stays filtered",
        );

        let local_id = driver
            .store()
            .id_local_read("documents", "srv1")
            .unwrap()
            .expect("the member keeps its local id mapping");
        driver
            .store()
            .commit(
                storage::WriteBatch {
                    deletes: vec![storage::DeleteIn {
                        table: "documents".to_owned(),
                        id: local_id.clone(),
                    }],
                    ..storage::WriteBatch::default()
                },
                &storage::CommitOptions::default(),
            )
            .unwrap();
        assert_eq!(
            driver.store().doc_read("documents", &local_id).unwrap(),
            None
        );
        assert_eq!(
            driver.store().id_local_read("documents", "srv1").unwrap(),
            Some(local_id),
            "an optimistic local deletion keeps the server id mapping until settlement",
        );

        let after_local_delete = assemble_result_pull(&mut driver, point_get_page("srv1", true));
        assert_eq!(
            after_local_delete.projections.len(),
            1,
            "a still-authoritative member must restore its missing projection so a co-delivered CRDT state can apply",
        );
    }
}
