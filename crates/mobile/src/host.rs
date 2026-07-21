use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard, OnceLock, PoisonError,
    },
};

use storage::{EmbeddedStore, StorageError};

use crate::{BridgeError, BridgeResult};

type Job = Box<dyn FnOnce(&EmbeddedStore) + Send>;

pub(crate) struct StoreHost {
    store: Arc<EmbeddedStore>,
    jobs: Mutex<Option<mpsc::Sender<Job>>>,
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

    fn close(&self) -> BridgeResult<()> {
        lock(&self.jobs).take();
        if let Some(thread) = lock(&self.thread).take() {
            thread
                .join()
                .map_err(|_| BridgeError::Host("storage thread panicked".to_owned()))?;
        }
        Ok(())
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
