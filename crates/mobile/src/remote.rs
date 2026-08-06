use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Condvar, Mutex, MutexGuard, PoisonError,
    },
    time::Duration,
};

use convex::AuthenticationToken;
use remote::driver::{RemoteDocPush, RemoteDocPushState};
use remote::{
    ClientId, DeploymentUrl, RemoteAuth, RemoteClient, RemoteConfig, RemoteCursor, RemoteScope,
    RemoteStore, RemoteSubscription, RemoteTick, RemoteTiming,
};
use serde::Deserialize;
use storage::{EmbeddedStore, IdMapping, PendingUpload, StorageError, UploadLeaseWrite};
use tokio::sync::oneshot;

use crate::{host::Job, BridgeError, BridgeResult};

const EVENT_CAPACITY: usize = 64;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartOptions {
    url: String,
    client_id: Option<String>,
    module_graph_hash: String,
    operation_timeout_ms: Option<u64>,
    protocol_version: i64,
    receive_timeout_ms: Option<u64>,
    schema_hash: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScopeInput {
    subscriptions: Vec<SubscriptionInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscriptionInput {
    #[serde(rename = "fn")]
    pull_fn: String,
    args: serde_json::Value,
    result_cache_key: String,
    cursor: Option<CursorInput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorInput {
    path: String,
    boundary: serde_json::Value,
}

#[derive(Clone)]
pub(crate) struct RemoteEvents {
    inner: Arc<EventInner>,
}

struct EventInner {
    next_auth: AtomicU64,
    changed: Condvar,
    state: Mutex<EventState>,
}

struct EventState {
    auth: HashMap<u64, oneshot::Sender<anyhow::Result<AuthenticationToken>>>,
    closed: bool,
    events: VecDeque<serde_json::Value>,
}

impl RemoteEvents {
    fn new() -> Self {
        Self {
            inner: Arc::new(EventInner {
                next_auth: AtomicU64::new(1),
                changed: Condvar::new(),
                state: Mutex::new(EventState {
                    auth: HashMap::new(),
                    closed: false,
                    events: VecDeque::new(),
                }),
            }),
        }
    }

    fn auth(&self) -> RemoteAuth {
        let events = self.clone();
        RemoteAuth::Fetcher(Arc::new(Box::new(move |force_refresh| {
            let events = events.clone();
            Box::pin(async move {
                let id = events.inner.next_auth.fetch_add(1, Ordering::Relaxed);
                let (tx, rx) = oneshot::channel();
                {
                    let mut state = lock(&events.inner.state);
                    while state.events.len() >= EVENT_CAPACITY && !state.closed {
                        state = events
                            .inner
                            .changed
                            .wait(state)
                            .unwrap_or_else(PoisonError::into_inner);
                    }
                    if state.closed {
                        return Err(anyhow::anyhow!("mobile remote is closed"));
                    }
                    state.auth.insert(id, tx);
                    state.events.push_back(serde_json::json!({
                        "kind": "auth",
                        "id": id,
                        "forceRefreshToken": force_refresh,
                    }));
                    events.inner.changed.notify_one();
                }
                rx.await
                    .map_err(|_| anyhow::anyhow!("mobile auth request was cancelled"))?
            })
        })))
    }

    fn notify(&self, tick: RemoteTick) {
        self.push(serde_json::json!({
            "kind": "tick",
            "tick": tick_value(tick),
        }));
    }

    fn actor_exit(&self, error: Option<String>) {
        self.notify(RemoteTick {
            pull_diagnostics: 1,
            pull_error: Some(error.unwrap_or_else(|| "mobile remote actor stopped".to_owned())),
            ..RemoteTick::default()
        });
    }

    fn push(&self, event: serde_json::Value) {
        let mut state = lock(&self.inner.state);
        while state.events.len() >= EVENT_CAPACITY && !state.closed {
            state = self
                .inner
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        if state.closed {
            return;
        }
        state.events.push_back(event);
        self.inner.changed.notify_one();
    }

    pub(crate) fn next(&self) -> Vec<serde_json::Value> {
        let mut state = lock(&self.inner.state);
        while state.events.is_empty() && !state.closed {
            state = self
                .inner
                .changed
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
        let events = state.events.drain(..).collect();
        self.inner.changed.notify_all();
        events
    }

    pub(crate) fn auth_write(
        &self,
        id: u64,
        token: Option<String>,
        error: Option<String>,
    ) -> BridgeResult<()> {
        let sender = lock(&self.inner.state)
            .auth
            .remove(&id)
            .ok_or_else(|| BridgeError::Protocol(format!("unknown mobile auth request {id}")))?;
        let value = match error {
            Some(error) => Err(anyhow::anyhow!(error)),
            None => Ok(token.map_or(AuthenticationToken::None, AuthenticationToken::User)),
        };
        sender
            .send(value)
            .map_err(|_| BridgeError::Closed("mobile auth request was cancelled".to_owned()))
    }

    fn cancel(&self) {
        let mut state = lock(&self.inner.state);
        state.closed = true;
        state.auth.clear();
        state.events.clear();
        self.inner.changed.notify_all();
    }
}

#[derive(Clone)]
pub(crate) struct RemoteHost {
    client: RemoteClient,
    events: RemoteEvents,
}

impl RemoteHost {
    pub(crate) fn start(options: StartOptions, jobs: mpsc::Sender<Job>) -> BridgeResult<Self> {
        let deployment_url = DeploymentUrl::parse(&options.url).map_err(remote_error)?;
        let mut config = RemoteConfig::new(deployment_url);
        if let Some(client_id) = options.client_id {
            let client_id = ClientId::new(client_id).map_err(remote_error)?;
            config.client_id = client_id.clone();
            config.author_client_id = client_id;
        }
        let events = RemoteEvents::new();
        config.auth = events.auth();
        config.runtime = storage::RuntimeWireIdentity {
            schema_hash: options.schema_hash,
            module_graph_hash: options.module_graph_hash,
            protocol_version: options.protocol_version,
        };
        config.timing = RemoteTiming {
            receive_timeout: options.receive_timeout_ms.map_or_else(
                || RemoteTiming::default().receive_timeout,
                Duration::from_millis,
            ),
            operation_timeout: options.operation_timeout_ms.map_or_else(
                || RemoteTiming::default().operation_timeout,
                Duration::from_millis,
            ),
        };
        let client = RemoteClient::open_with_store(
            config,
            Box::new(MobileRemoteStore {
                jobs,
                job_count: Arc::new(AtomicUsize::new(0)),
            }),
        )
        .map_err(remote_error)?;
        let observer = events.clone();
        let exit = events.clone();
        client
            .start_with_observer_and_exit(
                move |tick| observer.notify(tick),
                move |error| exit.actor_exit(error),
            )
            .map_err(remote_error)?;
        Ok(Self { client, events })
    }

    pub(crate) fn events(&self) -> &RemoteEvents {
        &self.events
    }

    pub(crate) fn pull(&self) -> BridgeResult<serde_json::Value> {
        block_on(self.client.pull()).map(tick_value)
    }

    pub(crate) fn identity(&self) -> BridgeResult<String> {
        block_on(self.client.identity())
    }

    pub(crate) fn doc_push(
        &self,
        table: &str,
        id: &str,
        first_commit_seq: i64,
        updated_commit_seq: i64,
    ) -> BridgeResult<serde_json::Value> {
        block_on(self.client.doc_push(
            table,
            id,
            storage::DirtyHeadToken {
                first_commit_seq,
                updated_commit_seq,
            },
        ))
        .map(doc_push_value)
    }

    pub(crate) fn scope_write(&self, json: &str) -> BridgeResult<()> {
        let input: ScopeInput = serde_json::from_str(json)?;
        let scope = RemoteScope {
            subscriptions: input
                .subscriptions
                .into_iter()
                .map(|subscription| RemoteSubscription {
                    pull_fn: subscription.pull_fn,
                    pull_args: subscription.args,
                    result_cache_key: Some(subscription.result_cache_key),
                    cursor: subscription.cursor.map(|cursor| RemoteCursor {
                        path: cursor.path,
                        boundary: cursor.boundary,
                    }),
                })
                .collect(),
        };
        block_on(self.client.scope_write(scope))
    }

    pub(crate) fn close(self) -> BridgeResult<()> {
        self.events.cancel();
        block_on(self.client.close())
    }
}

fn block_on<T>(
    future: impl std::future::Future<Output = remote::RemoteResult<T>>,
) -> BridgeResult<T> {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| {
            BridgeError::Host(format!("failed to create mobile remote runtime: {error}"))
        })?
        .block_on(future)
        .map_err(remote_error)
}

#[expect(
    clippy::needless_pass_by_value,
    reason = "passed as a function item to Result::map_err, which transfers the error"
)]
fn remote_error(error: remote::RemoteError) -> BridgeError {
    BridgeError::Remote(error.to_string())
}

fn tick_value(tick: RemoteTick) -> serde_json::Value {
    let connected = tick.connected;
    let pending_absent = tick.pending.is_none();
    let mut value = serde_json::json!({
        "connected": tick.connected,
        "changedTables": tick.changed_tables,
        "rowsApplied": tick.rows_applied,
        "pullAttempted": tick.pull_attempted,
        "pushAccepted": tick.push_accepted,
        "pushAttempted": tick.push_attempted,
        "received": tick.received,
        "reconnected": tick.reconnected,
        "pushed": tick.pushed,
        "pushFailed": tick.push_failed,
        "pushConflicts": tick.push_conflicts,
        "pushRebases": tick.push_rebases,
        "retainedRevisions": tick.retained_revisions.into_iter().map(reroot_value).collect::<Vec<_>>(),
        "settlements": tick.settlements.into_iter().map(settlement_value).collect::<Vec<_>>(),
        "sent": tick.sent,
        "receiptsPushed": tick.receipts_pushed,
        "storeJobs": tick.store_jobs,
        "pullChangesApplied": tick.pull_changes_applied,
        "pullSnapshots": tick.pull_snapshots,
        "pullDiagnostics": tick.pull_diagnostics,
        "pullError": tick.pull_error,
        "changedResults": tick.changed_results,
        "pending": tick.pending.map(|pending| serde_json::json!({
            "checkpoints": pending.checkpoints,
            "inflight": pending.inflight,
            "mutations": pending.mutations,
            "scope": pending.scope,
            "settlements": pending.settlements,
            "uploads": pending.uploads,
        })),
    });
    let object = value
        .as_object_mut()
        .expect("mobile tick wire value must be an object");
    if connected.is_none() {
        object.remove("connected");
    }
    if pending_absent {
        object.remove("pending");
    }
    value
}

fn reroot_value(revision: storage::RetainedRevision) -> serde_json::Value {
    serde_json::json!({
        "table": revision.table,
        "id": revision.local_document_id,
        "revId": revision.server_rev_id.unwrap_or(revision.archived_rev_id),
    })
}

fn settlement_value(settlement: remote::RemoteMutationSettlement) -> serde_json::Value {
    let (mutation_id, function_name, outcome, retained_revisions) = settlement.into_parts();
    let mut fields = serde_json::Map::from_iter([
        (
            "mutationId".to_owned(),
            serde_json::Value::String(mutation_id),
        ),
        (
            "functionName".to_owned(),
            serde_json::Value::String(function_name),
        ),
        (
            "outcome".to_owned(),
            serde_json::Value::String(outcome.as_str().to_owned()),
        ),
        (
            "retainedRevisions".to_owned(),
            serde_json::Value::Array(retained_revisions.into_iter().map(reroot_value).collect()),
        ),
    ]);
    if let Some(code) = outcome.code() {
        fields.insert(
            "code".to_owned(),
            serde_json::Value::String(code.to_owned()),
        );
    }
    serde_json::Value::Object(fields)
}

fn doc_push_value(pushed: RemoteDocPush) -> serde_json::Value {
    serde_json::json!({
        "state": match pushed.state {
            RemoteDocPushState::Blocked => "blocked",
            RemoteDocPushState::Settled => "settled",
            RemoteDocPushState::Stale => "stale",
        },
        "tick": tick_value(pushed.tick),
    })
}

struct MobileRemoteStore {
    jobs: mpsc::Sender<Job>,
    job_count: Arc<AtomicUsize>,
}

impl MobileRemoteStore {
    fn run<T, F>(&self, work: F) -> Result<T, StorageError>
    where
        T: Send + 'static,
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError> + Send + 'static,
    {
        let (tx, rx) = mpsc::sync_channel(1);
        self.jobs
            .send(Box::new(move |store| {
                tx.send(work(store)).ok();
            }))
            .map_err(|_| StorageError::Unsatisfiable("storage thread terminated".to_owned()))?;
        self.job_count.fetch_add(1, Ordering::Relaxed);
        rx.recv()
            .map_err(|_| StorageError::Unsatisfiable("storage thread terminated".to_owned()))?
    }

    fn queue<T, F>(&self, work: F) -> remote::RemoteStoreFuture<T>
    where
        T: Send + 'static,
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError> + Send + 'static,
    {
        let (tx, rx) = oneshot::channel();
        if self
            .jobs
            .send(Box::new(move |store| {
                tx.send(work(store)).ok();
            }))
            .is_err()
        {
            return Box::pin(std::future::ready(Err(StorageError::Unsatisfiable(
                "storage thread terminated".to_owned(),
            ))));
        }
        self.job_count.fetch_add(1, Ordering::Relaxed);
        Box::pin(async move {
            rx.await
                .map_err(|_| StorageError::Unsatisfiable("storage thread terminated".to_owned()))?
        })
    }
}

impl RemoteStore for MobileRemoteStore {
    fn store_job_count(&self) -> usize {
        self.job_count.load(Ordering::Relaxed)
    }
    fn schema_table_names(&self) -> Result<Vec<String>, StorageError> {
        self.run(|s| Ok(s.schema_table_names()))
    }
    fn identity_write(&self, key: &str, json: Option<&str>) -> Result<(), StorageError> {
        let key = key.to_owned();
        let json = json.map(str::to_owned);
        self.run(move |s| s.identity_write(&key, json.as_deref()))
    }
    fn upload_has_pending(&self) -> Result<bool, StorageError> {
        self.run(EmbeddedStore::upload_has_pending)
    }
    fn upload_lease_write(
        &self,
        args: UploadLeaseWrite,
    ) -> Result<Option<PendingUpload>, StorageError> {
        self.run(move |s| s.upload_lease_write(args))
    }
    fn upload_complete(
        &self,
        local: &str,
        owner: &str,
        convex: &str,
        now: i64,
    ) -> Result<bool, StorageError> {
        let local = local.to_owned();
        let owner = owner.to_owned();
        let convex = convex.to_owned();
        self.run(move |s| s.upload_complete(&local, &owner, &convex, now))
    }
    fn blob_read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let key = key.to_owned();
        self.run(move |s| s.blob_read(&key))
    }
    fn blob_write(&self, key: &str, bytes: Vec<u8>) -> Result<(), StorageError> {
        let key = key.to_owned();
        self.run(move |s| s.blob_write(&key, bytes))
    }
    fn id_read(&self, table: &str, id: &str) -> Result<Option<IdMapping>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |s| s.id_read(&table, &id))
    }
    fn id_local_read(&self, table: &str, id: &str) -> Result<Option<String>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |s| s.id_local_read(&table, &id))
    }
    fn doc_read(&self, table: &str, id: &str) -> Result<Option<String>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |s| s.doc_read(&table, &id))
    }
    fn remote_doc_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Option<storage::RowHead>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |s| s.remote_doc_read(&table, &id))
    }
    fn remote_cursor_read(&self, subscription: &str) -> Result<Option<String>, StorageError> {
        let value = subscription.to_owned();
        self.run(move |s| s.remote_cursor_read(&value))
    }
    fn remote_progress_has(&self) -> Result<bool, StorageError> {
        self.run(EmbeddedStore::remote_progress_has)
    }
    fn remote_subscription_read(&self) -> Result<Vec<String>, StorageError> {
        self.run(EmbeddedStore::remote_subscription_read)
    }
    fn remote_pending_read(&self) -> Result<storage::RemotePending, StorageError> {
        self.run(EmbeddedStore::remote_pending_read)
    }
    fn remote_push_envelope_read(&self, n: usize) -> Result<Vec<String>, StorageError> {
        self.run(move |s| s.remote_push_envelope_read(n))
    }
    fn remote_push_replay_write(
        &self,
        mutation_id: &str,
        expected_commit_seq: i64,
        expected_replay_id: &str,
        replay_id: &str,
        now_ms: i64,
    ) -> Result<(), StorageError> {
        let mutation_id = mutation_id.to_owned();
        let expected_replay_id = expected_replay_id.to_owned();
        let replay_id = replay_id.to_owned();
        self.run(move |s| {
            s.remote_push_replay_write(
                &mutation_id,
                expected_commit_seq,
                &expected_replay_id,
                &replay_id,
                now_ms,
            )
        })
    }
    fn remote_settlement_write(
        &self,
        value: &storage::RemoteSettlementWrite,
    ) -> Result<storage::RemoteSettlementWriteResult, StorageError> {
        let value = value.clone();
        self.run(move |s| s.remote_settlement_write(&value))
    }
    fn remote_receipt_read(&self, n: usize) -> Result<Vec<String>, StorageError> {
        self.run(move |s| s.remote_receipt_read(n))
    }
    fn remote_receipt_delete(&self, ids: &[String]) -> Result<(), StorageError> {
        let ids = ids.to_vec();
        self.run(move |s| s.remote_receipt_delete(&ids))
    }
    fn crdt_remote_state(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
    ) -> Result<Option<storage::CrdtRemoteState>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        let field = field.to_owned();
        self.run(move |s| s.crdt_remote_state(&table, &id, &field, kind))
    }
    fn crdt_remote_effect(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
        prior: &[Vec<u8>],
        payload: &[u8],
    ) -> Result<storage::CrdtRemoteEffect, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        let field = field.to_owned();
        let prior = prior.to_vec();
        let payload = payload.to_vec();
        self.run(move |s| s.crdt_remote_effect(&table, &id, &field, kind, &prior, &payload))
    }
    fn crdt_read_states(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtReadState>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |s| s.crdt_read_states(&table, &id))
    }
    fn crdt_snapshot_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtSnapshot>, StorageError> {
        let table = table.to_owned();
        let id = id.to_owned();
        self.run(move |s| s.crdt_snapshot_read(&table, &id))
    }
    fn remote_page_write(
        &self,
        pull: storage::RemotePageWrite,
    ) -> remote::RemoteStoreFuture<storage::RemotePageWriteResult> {
        self.queue(move |s| s.remote_page_write(&pull))
    }
    fn remote_subscription_delete_queue(
        &self,
        subscription: String,
        now: i64,
    ) -> remote::RemoteStoreFuture<storage::RemotePageWriteResult> {
        self.queue(move |s| s.remote_subscription_delete(&subscription, now))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

#[cfg(test)]
mod tests {
    use std::sync::{atomic::AtomicUsize, mpsc, Arc, Barrier};

    use convex::AuthenticationToken;
    use remote::{RemoteAuth, RemoteStore};

    use super::{tick_value, MobileRemoteStore, RemoteEvents};
    use crate::host::Job;

    #[test]
    fn remote_store_forwards_replay_id_rotation_to_storage() {
        let path = storage::testkit::tmp_path("mobile_remote_replay_rotation.db");
        let thread_path = path.clone();
        let (jobs, work) = mpsc::channel::<Job>();
        let thread = std::thread::spawn(move || {
            let store = storage::EmbeddedStore::open(thread_path.to_str().unwrap())
                .expect("test store should open");
            while let Ok(job) = work.recv() {
                job(&store);
            }
        });
        let remote = MobileRemoteStore {
            jobs,
            job_count: Arc::new(AtomicUsize::new(0)),
        };
        remote
            .run(|store| {
                store.setup(&storage::testkit::schema())?;
                store.remote_push_envelope_write(
                    "edit",
                    7,
                    r#"{"mutationId":"edit","replayId":"attempt-1"}"#,
                    1,
                )
            })
            .expect("test replay envelope should be queued");

        remote
            .remote_push_replay_write("edit", 7, "attempt-1", "attempt-2", 2)
            .expect("mobile remote store should forward replay rotation");

        let envelope = remote
            .remote_push_envelope_read(1)
            .expect("rotated replay envelope should be readable");
        assert_eq!(envelope.len(), 1);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&envelope[0]).unwrap()["replayId"],
            "attempt-2"
        );

        drop(remote);
        thread.join().expect("storage thread should stop");
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn close_unblocks_an_idle_event_waiter() {
        let events = RemoteEvents::new();
        let waiter = events.clone();
        let ready = Arc::new(Barrier::new(2));
        let waiter_ready = Arc::clone(&ready);
        let thread = std::thread::spawn(move || {
            waiter_ready.wait();
            waiter.next()
        });

        ready.wait();
        events.cancel();

        assert!(thread
            .join()
            .expect("event waiter should not panic")
            .is_empty());
    }

    #[test]
    fn auth_requests_round_trip_through_the_event_queue() {
        let events = RemoteEvents::new();
        let RemoteAuth::Fetcher(fetcher) = events.auth() else {
            panic!("mobile auth must use the event fetcher");
        };
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime should build")
            .block_on(async {
                let task = tokio::spawn((fetcher.as_ref())(true));
                tokio::task::yield_now().await;
                let queued = events.next();
                assert_eq!(queued.len(), 1);
                assert_eq!(queued[0]["kind"], "auth");
                assert_eq!(queued[0]["forceRefreshToken"], true);
                let id = queued[0]["id"].as_u64().expect("auth id should be u64");

                events
                    .auth_write(id, Some("token".to_owned()), None)
                    .expect("auth response should resolve");

                let token = task
                    .await
                    .expect("auth task should not panic")
                    .expect("auth should resolve");
                assert!(matches!(token, AuthenticationToken::User(value) if value == "token"));
            });
    }

    #[test]
    fn auth_started_after_close_is_rejected_without_an_orphaned_waiter() {
        let events = RemoteEvents::new();
        let RemoteAuth::Fetcher(fetcher) = events.auth() else {
            panic!("mobile auth must use the event fetcher");
        };
        events.cancel();

        let error = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime should build")
            .block_on((fetcher.as_ref())(false))
            .expect_err("auth after close must fail");

        assert!(error.to_string().contains("closed"));
        assert!(events.next().is_empty());
    }

    #[test]
    fn connectivity_transitions_cross_the_mobile_wire() {
        let tick = tick_value(remote::RemoteTick {
            connected: Some(false),
            ..remote::RemoteTick::default()
        });

        assert_eq!(tick["connected"], false);
    }

    #[test]
    fn an_absent_pending_snapshot_is_omitted_rather_than_serialized_as_null() {
        let tick = tick_value(remote::RemoteTick::default());

        assert!(tick.get("pending").is_none());
        assert!(tick.get("connected").is_none());
        assert_eq!(tick["settlements"], serde_json::json!([]));
    }

    #[test]
    fn a_present_pending_snapshot_crosses_the_mobile_wire() {
        let tick = tick_value(remote::RemoteTick {
            pending: Some(remote::RemotePending {
                mutations: 3,
                ..remote::RemotePending::default()
            }),
            ..remote::RemoteTick::default()
        });

        assert_eq!(tick["pending"]["mutations"], 3);
        assert_eq!(tick["pending"]["checkpoints"], 0);
    }
}
