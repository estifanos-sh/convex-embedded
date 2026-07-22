use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard, OnceLock, PoisonError,
    },
};

use storage::{EmbeddedStore, StorageError};

use crate::{BridgeError, BridgeResult};

pub(crate) type Job = Box<dyn FnOnce(&EmbeddedStore) + Send>;

pub(crate) struct StoreHost {
    store: Arc<EmbeddedStore>,
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
    remote: Mutex<Option<crate::remote::RemoteHost>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl StoreHost {
    fn open(
        path: String,
        selector_key: String,
        default_identity_key: String,
    ) -> BridgeResult<Self> {
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (jobs_tx, jobs_rx) = mpsc::channel::<Job>();
        let thread = std::thread::Builder::new()
            .name("convex-embedded-mobile-storage".to_owned())
            .spawn(move || {
                let store = EmbeddedStore::open_with_cached_identity_key(
                    &path,
                    &selector_key,
                    &default_identity_key,
                )
                .map(Arc::new);
                let Ok(store) = store.inspect_err(|error| {
                    ready_tx.send(Err(error.to_string())).ok();
                }) else {
                    return;
                };
                if ready_tx.send(Ok(store.clone())).is_err() {
                    return;
                }
                while let Ok(job) = jobs_rx.recv() {
                    job(&store);
                }
            })
            .map_err(|error| {
                BridgeError::Host(format!("failed to spawn storage thread: {error}"))
            })?;
        let store = ready_rx
            .recv()
            .map_err(|_| BridgeError::Closed("storage thread terminated during open".to_owned()))?
            .map_err(BridgeError::Storage)?;
        Ok(Self {
            store,
            jobs: Mutex::new(Some(jobs_tx)),
            remote: Mutex::new(None),
            thread: Mutex::new(Some(thread)),
        })
    }

    pub(crate) fn clock_read(&self) -> BridgeResult<f64> {
        self.store.clock_read().map_err(BridgeError::from)
    }

    pub(crate) fn run<T, F>(&self, work: F) -> BridgeResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&EmbeddedStore) -> Result<T, StorageError> + Send + 'static,
    {
        let jobs = lock(&self.jobs)
            .as_ref()
            .cloned()
            .ok_or_else(|| BridgeError::Closed("store is closed".to_owned()))?;
        let (tx, rx) = mpsc::sync_channel(1);
        jobs.send(Box::new(move |store| {
            tx.send(work(store)).ok();
        }))
        .map_err(|_| BridgeError::Closed("storage thread terminated".to_owned()))?;
        rx.recv()
            .map_err(|_| BridgeError::Closed("storage thread terminated".to_owned()))?
            .map_err(BridgeError::from)
    }

    pub(crate) fn remote_start(&self, options: crate::remote::StartOptions) -> BridgeResult<()> {
        let mut remote = lock(&self.remote);
        if remote.is_some() {
            return Err(BridgeError::Remote(
                "remote client is already started".to_owned(),
            ));
        }
        let jobs = lock(&self.jobs)
            .as_ref()
            .cloned()
            .ok_or_else(|| BridgeError::Closed("store is closed".to_owned()))?;
        *remote = Some(crate::remote::RemoteHost::start(options, jobs)?);
        Ok(())
    }

    pub(crate) fn remote_next(&self) -> BridgeResult<Vec<serde_json::Value>> {
        let remote = lock(&self.remote)
            .as_ref()
            .cloned()
            .ok_or_else(|| BridgeError::Remote("remote client is not started".to_owned()))?;
        Ok(remote.events().next())
    }

    pub(crate) fn remote_auth_write(
        &self,
        id: u64,
        token: Option<String>,
        error: Option<String>,
    ) -> BridgeResult<()> {
        let remote = lock(&self.remote)
            .as_ref()
            .cloned()
            .ok_or_else(|| BridgeError::Remote("remote client is not started".to_owned()))?;
        remote.events().auth_write(id, token, error)
    }

    pub(crate) fn remote_pull(&self) -> BridgeResult<serde_json::Value> {
        self.with_remote(|remote| remote.pull())
    }

    pub(crate) fn remote_identity(&self) -> BridgeResult<String> {
        self.with_remote(|remote| remote.identity())
    }

    pub(crate) fn remote_doc_push(
        &self,
        table: &str,
        id: &str,
        first_commit_seq: i64,
        updated_commit_seq: i64,
    ) -> BridgeResult<serde_json::Value> {
        self.with_remote(|remote| remote.doc_push(table, id, first_commit_seq, updated_commit_seq))
    }

    pub(crate) fn remote_scope_write(&self, scope: &str) -> BridgeResult<()> {
        self.with_remote(|remote| remote.scope_write(scope))
    }

    pub(crate) fn remote_close(&self) -> BridgeResult<()> {
        let remote = lock(&self.remote).take();
        if let Some(remote) = remote {
            remote.close()?;
        }
        Ok(())
    }

    fn with_remote<T>(
        &self,
        operation: impl FnOnce(crate::remote::RemoteHost) -> BridgeResult<T>,
    ) -> BridgeResult<T> {
        let remote = lock(&self.remote)
            .as_ref()
            .cloned()
            .ok_or_else(|| BridgeError::Remote("remote client is not started".to_owned()))?;
        operation(remote)
    }

    fn close(&self) -> BridgeResult<()> {
        let remote_result = self.remote_close();
        lock(&self.jobs).take();
        if let Some(thread) = lock(&self.thread).take() {
            thread
                .join()
                .map_err(|_| BridgeError::Host("storage thread panicked".to_owned()))?;
        }
        remote_result
    }
}

static NEXT_HANDLE: AtomicU64 = AtomicU64::new(1);
static STORES: OnceLock<Mutex<HashMap<u64, Arc<StoreHost>>>> = OnceLock::new();

fn stores() -> &'static Mutex<HashMap<u64, Arc<StoreHost>>> {
    STORES.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) fn open(
    path: String,
    selector_key: Option<String>,
    default_identity_key: Option<String>,
) -> BridgeResult<u64> {
    let selector_key = selector_key.unwrap_or_default();
    let default_identity_key = default_identity_key.unwrap_or_else(|| selector_key.clone());
    let host = Arc::new(StoreHost::open(path, selector_key, default_identity_key)?);
    let handle = NEXT_HANDLE.fetch_add(1, Ordering::Relaxed);
    if handle == 0 {
        return Err(BridgeError::Host(
            "mobile store handle space exhausted".to_owned(),
        ));
    }
    lock(stores()).insert(handle, host);
    Ok(handle)
}

pub(crate) fn read(handle: u64) -> BridgeResult<Arc<StoreHost>> {
    lock(stores())
        .get(&handle)
        .cloned()
        .ok_or_else(|| BridgeError::Closed(format!("unknown or closed store handle {handle}")))
}

pub(crate) fn close(handle: u64) -> BridgeResult<()> {
    let host = lock(stores())
        .remove(&handle)
        .ok_or_else(|| BridgeError::Closed(format!("unknown or closed store handle {handle}")))?;
    host.close()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}
