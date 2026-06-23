#![cfg(not(target_arch = "wasm32"))]

use std::sync::{Arc, Mutex};

use tokio::sync::{mpsc, oneshot};

use crate::{
    config::RemoteConfig,
    driver::{RemoteCommand, RemoteDocPush, RemoteDriver, RemoteScope},
    store::RemoteStore,
    transport::WebSocketTransport,
    RemoteError, RemoteResult, RemoteTick, SystemRemoteClock,
};

#[derive(Clone)]
pub struct RemoteClient {
    inner: Arc<RemoteInner>,
}

struct RemoteInner {
    state: Mutex<RemoteState>,
}

enum RemoteState {
    NotStarted(Option<Box<RemoteDriver<WebSocketTransport, Box<dyn RemoteStore + Send>>>>),
    Running {
        commands: mpsc::Sender<RemoteCommand>,
        join: Option<std::thread::JoinHandle<RemoteResult<()>>>,
    },
    Closing,
    Closed,
    Exited,
}

impl RemoteClient {
    pub fn open(config: RemoteConfig, store: Arc<storage::EmbeddedStore>) -> RemoteResult<Self> {
        Self::open_with_store(config, Box::new(store))
    }

    pub fn open_with_store(
        config: RemoteConfig,
        store: Box<dyn RemoteStore + Send>,
    ) -> RemoteResult<Self> {
        let driver = RemoteDriver::open_with_store(
            config,
            store,
            WebSocketTransport::new(),
            SystemRemoteClock::default(),
        );
        Ok(Self {
            inner: Arc::new(RemoteInner {
                state: Mutex::new(RemoteState::NotStarted(Some(Box::new(driver)))),
            }),
        })
    }

    pub fn start(&self) -> RemoteResult<()> {
        self.start_with_observer(|_| {})
    }

    pub fn start_with_observer<F>(&self, observe: F) -> RemoteResult<()>
    where
        F: Fn(RemoteTick) + Send + 'static,
    {
        let mut state = lock(&self.inner.state);
        let driver = match &mut *state {
            RemoteState::NotStarted(driver) => *driver.take().ok_or(RemoteError::AlreadyStarted)?,
            RemoteState::Running { .. } => return Err(RemoteError::AlreadyStarted),
            RemoteState::Closing | RemoteState::Closed | RemoteState::Exited => {
                return Err(RemoteError::Closed);
            }
        };
        let (commands, receiver) = mpsc::channel(64);
        let join = std::thread::Builder::new()
            .name("convex-embedded-remote".to_owned())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|error| RemoteError::Join(error.to_string()))?;
                runtime.block_on(driver.run_with_observer(receiver, observe))
            })
            .map_err(|error| RemoteError::Join(error.to_string()))?;
        *state = RemoteState::Running {
            commands,
            join: Some(join),
        };
        Ok(())
    }

    pub async fn close(&self) -> RemoteResult<()> {
        let (commands, join) = {
            let mut state = lock(&self.inner.state);
            match std::mem::replace(&mut *state, RemoteState::Closed) {
                RemoteState::NotStarted(_)
                | RemoteState::Closing
                | RemoteState::Closed
                | RemoteState::Exited => {
                    *state = RemoteState::Closed;
                    return Ok(());
                }
                RemoteState::Running { commands, join } => {
                    *state = RemoteState::Closing;
                    (commands, join)
                }
            }
        };

        let (tx, rx) = oneshot::channel();
        let close_result = if commands
            .send(RemoteCommand::Close { response: tx })
            .await
            .is_err()
        {
            Ok(())
        } else {
            rx.await.unwrap_or(Ok(()))
        };

        let mut join_result = Ok(());
        if let Some(join) = join {
            join_result = match join.join() {
                Ok(result) => result,
                Err(error) => Err(RemoteError::Join(thread_panic(error.as_ref()))),
            };
        }
        *lock(&self.inner.state) = RemoteState::Closed;
        join_result?;
        close_result
    }

    pub async fn pull(&self) -> RemoteResult<RemoteTick> {
        let (tx, rx) = oneshot::channel();
        self.commands()?
            .send(RemoteCommand::PullOnce { response: tx })
            .await?;
        rx.await.map_err(|_| RemoteError::Closed)?
    }

    pub async fn doc_push(
        &self,
        table: &str,
        local_document_id: &str,
        token: storage::DirtyHeadToken,
    ) -> RemoteResult<RemoteDocPush> {
        let (tx, rx) = oneshot::channel();
        self.commands()?
            .send(RemoteCommand::DocPush {
                table: table.to_owned(),
                local_document_id: local_document_id.to_owned(),
                token,
                response: tx,
            })
            .await?;
        rx.await.map_err(|_| RemoteError::Closed)?
    }

    pub async fn scope_write(&self, scope: RemoteScope) -> RemoteResult<()> {
        let (tx, rx) = oneshot::channel();
        self.commands()?
            .send(RemoteCommand::ScopeWrite {
                scope,
                response: tx,
            })
            .await?;
        rx.await.map_err(|_| RemoteError::Closed)?
    }

    pub async fn identity(&self) -> RemoteResult<String> {
        let (tx, rx) = oneshot::channel();
        self.commands()?
            .send(RemoteCommand::Identity { response: tx })
            .await?;
        rx.await.map_err(|_| RemoteError::Closed)?
    }

    fn commands(&self) -> RemoteResult<mpsc::Sender<RemoteCommand>> {
        let join = {
            let mut state = lock(&self.inner.state);
            match &mut *state {
                RemoteState::Running { join, .. }
                    if join
                        .as_ref()
                        .is_some_and(std::thread::JoinHandle::is_finished) =>
                {
                    match std::mem::replace(&mut *state, RemoteState::Exited) {
                        RemoteState::Running { join, .. } => join,
                        _ => None,
                    }
                }
                RemoteState::Running { commands, .. } => return Ok(commands.clone()),
                RemoteState::NotStarted(_) => return Err(RemoteError::NotStarted),
                RemoteState::Closing | RemoteState::Closed | RemoteState::Exited => {
                    return Err(RemoteError::Closed);
                }
            }
        };
        if let Some(join) = join {
            match join.join() {
                Ok(Ok(())) => Err(RemoteError::Closed),
                Ok(Err(error)) => Err(error),
                Err(error) => Err(RemoteError::Join(thread_panic(error.as_ref()))),
            }
        } else {
            Err(RemoteError::Closed)
        }
    }
}

impl From<mpsc::error::SendError<RemoteCommand>> for RemoteError {
    fn from(_: mpsc::error::SendError<RemoteCommand>) -> Self {
        Self::Closed
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn thread_panic(error: &(dyn std::any::Any + Send)) -> String {
    error.downcast_ref::<&str>().map_or_else(
        || {
            error
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "remote thread panicked".to_owned())
        },
        |message| (*message).to_owned(),
    )
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::RemoteClient;
    use crate::config::RemoteConfig;

    #[test]
    fn native_client_owns_its_runtime() {
        let path = storage::testkit::tmp_path("remote-owned-runtime.db");
        let store = Arc::new(storage::EmbeddedStore::open(path.to_str().unwrap()).unwrap());
        store.setup(&storage::testkit::schema()).unwrap();
        let client = RemoteClient::open(
            RemoteConfig::new("https://example.convex.cloud".parse().unwrap()),
            store,
        )
        .unwrap();

        client.start().unwrap();

        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(client.close())
            .unwrap();
    }
}
