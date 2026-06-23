use std::{future::Future, pin::Pin};

use storage::{
    IdMapping, PendingUpload, RemotePull, RemotePullResult, RemotePushSettlement,
    RemotePushSettlementResult, RowHead, StorageError, UploadLeaseWrite,
};

use crate::RemoteResult;

pub type RemoteStoreFuture<T> =
    Pin<Box<dyn Future<Output = Result<T, StorageError>> + Send + 'static>>;

pub trait RemoteStore {
    fn store_job_count(&self) -> usize {
        0
    }

    fn schema_table_names(&self) -> Result<Vec<String>, StorageError>;
    fn identity_write(
        &self,
        _identity_key: &str,
        _identity_json: Option<&str>,
    ) -> Result<(), StorageError> {
        Ok(())
    }
    fn upload_has_pending(&self) -> Result<bool, StorageError>;
    fn upload_lease_write(
        &self,
        args: UploadLeaseWrite,
    ) -> Result<Option<PendingUpload>, StorageError>;
    fn upload_complete(
        &self,
        local_storage_id: &str,
        owner: &str,
        convex_id: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError>;
    fn blob_read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError>;
    fn blob_write(&self, key: &str, bytes: Vec<u8>) -> Result<(), StorageError>;
    fn id_read(&self, table: &str, local_id: &str) -> Result<Option<IdMapping>, StorageError>;
    fn id_local_read(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError>;
    fn projection_read(&self, table: &str, local_id: &str)
        -> Result<Option<RowHead>, StorageError>;

    fn remote_read_cursor(&self, subscription: &str) -> Result<Option<String>, StorageError>;
    fn remote_progress_has(&self) -> Result<bool, StorageError>;
    fn remote_subscription_read(&self) -> Result<Vec<String>, StorageError>;
    fn remote_push_envelope_read(&self, num_items: usize) -> Result<Vec<String>, StorageError>;
    fn remote_push_settle(
        &self,
        settlement: &RemotePushSettlement,
    ) -> Result<RemotePushSettlementResult, StorageError>;
    fn remote_settlement_ack_read(&self, _num_items: usize) -> Result<Vec<String>, StorageError> {
        Ok(Vec::new())
    }
    fn remote_settlement_ack_complete(&self, _mutation_ids: &[String]) -> Result<(), StorageError> {
        Ok(())
    }

    fn crdt_remote_state(
        &self,
        _table: &str,
        _id: &str,
        _field: &str,
        _kind: storage::CrdtFieldKind,
    ) -> Result<Option<storage::CrdtRemoteState>, StorageError> {
        Ok(None)
    }
    fn crdt_remote_effect(
        &self,
        _table: &str,
        _id: &str,
        _field: &str,
        _kind: storage::CrdtFieldKind,
        _prior_payloads: &[Vec<u8>],
        _payload: &[u8],
    ) -> Result<storage::CrdtRemoteEffect, StorageError> {
        Err(StorageError::Unsatisfiable(
            "remote store cannot prepare CRDT effects".to_owned(),
        ))
    }
    fn crdt_read_states(
        &self,
        _table: &str,
        _id: &str,
    ) -> Result<Vec<storage::CrdtReadState>, StorageError> {
        Ok(Vec::new())
    }
    fn crdt_snapshot_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtSnapshot>, StorageError>;
    fn remote_pull_page_queue(&self, pull: RemotePull) -> RemoteStoreFuture<RemotePullResult>;
    fn remote_subscription_delete_queue(
        &self,
        subscription: String,
        now_ms: i64,
    ) -> RemoteStoreFuture<RemotePullResult>;
}

pub trait RemoteClock {
    fn monotonic_ms(&self) -> u64;
    fn now_ms(&self) -> RemoteResult<i64>;
}

#[cfg(target_arch = "wasm32")]
pub struct UnavailableRemoteClock;

#[cfg(target_arch = "wasm32")]
impl RemoteClock for UnavailableRemoteClock {
    fn monotonic_ms(&self) -> u64 {
        0
    }

    fn now_ms(&self) -> RemoteResult<i64> {
        Err(crate::RemoteError::InvalidConfig(
            "browser remote requires a host clock".to_owned(),
        ))
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub struct SystemRemoteClock {
    start: std::time::Instant,
}

#[cfg(not(target_arch = "wasm32"))]
impl Default for SystemRemoteClock {
    fn default() -> Self {
        Self {
            start: std::time::Instant::now(),
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl RemoteClock for SystemRemoteClock {
    fn monotonic_ms(&self) -> u64 {
        u64::try_from(self.start.elapsed().as_millis()).unwrap_or(u64::MAX)
    }

    fn now_ms(&self) -> RemoteResult<i64> {
        let wall = storage::clock::wall_ms().map_err(crate::RemoteError::Storage)?;
        if !wall.is_finite() || wall < 0.0 || wall > i64::MAX as f64 {
            Err(crate::RemoteError::Protocol(
                "current time is outside i64 milliseconds".to_owned(),
            ))
        } else {
            Ok(wall as i64)
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl RemoteStore for std::sync::Arc<storage::EmbeddedStore> {
    fn schema_table_names(&self) -> Result<Vec<String>, StorageError> {
        Ok(storage::EmbeddedStore::schema_table_names(self))
    }
    fn identity_write(
        &self,
        identity_key: &str,
        identity_json: Option<&str>,
    ) -> Result<(), StorageError> {
        storage::EmbeddedStore::identity_write(self, identity_key, identity_json)
    }
    fn upload_has_pending(&self) -> Result<bool, StorageError> {
        storage::EmbeddedStore::upload_has_pending(self)
    }
    fn upload_lease_write(
        &self,
        args: UploadLeaseWrite,
    ) -> Result<Option<PendingUpload>, StorageError> {
        storage::EmbeddedStore::upload_lease_write(self, args)
    }
    fn upload_complete(
        &self,
        local_storage_id: &str,
        owner: &str,
        convex_id: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        storage::EmbeddedStore::upload_complete(self, local_storage_id, owner, convex_id, now_ms)
    }
    fn blob_read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        storage::EmbeddedStore::blob_read(self, key)
    }
    fn blob_write(&self, key: &str, bytes: Vec<u8>) -> Result<(), StorageError> {
        storage::EmbeddedStore::blob_write(self, key, bytes)
    }
    fn id_read(&self, table: &str, local_id: &str) -> Result<Option<IdMapping>, StorageError> {
        storage::EmbeddedStore::id_read(self, table, local_id)
    }
    fn id_local_read(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        storage::EmbeddedStore::id_local_read(self, table, server_document_id)
    }
    fn projection_read(
        &self,
        table: &str,
        local_id: &str,
    ) -> Result<Option<RowHead>, StorageError> {
        storage::EmbeddedStore::projection_read(self, table, local_id)
    }
    fn remote_read_cursor(&self, subscription: &str) -> Result<Option<String>, StorageError> {
        storage::EmbeddedStore::remote_read_cursor(self, subscription)
    }
    fn remote_progress_has(&self) -> Result<bool, StorageError> {
        storage::EmbeddedStore::remote_progress_has(self)
    }
    fn remote_subscription_read(&self) -> Result<Vec<String>, StorageError> {
        storage::EmbeddedStore::remote_subscription_read(self)
    }
    fn remote_push_envelope_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        storage::EmbeddedStore::remote_push_envelope_read(self, num_items)
    }
    fn remote_push_settle(
        &self,
        settlement: &RemotePushSettlement,
    ) -> Result<RemotePushSettlementResult, StorageError> {
        storage::EmbeddedStore::remote_push_settle(self, settlement)
    }
    fn remote_settlement_ack_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        storage::EmbeddedStore::remote_settlement_ack_read(self, num_items)
    }
    fn remote_settlement_ack_complete(&self, mutation_ids: &[String]) -> Result<(), StorageError> {
        storage::EmbeddedStore::remote_settlement_ack_complete(self, mutation_ids)
    }
    fn crdt_remote_state(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
    ) -> Result<Option<storage::CrdtRemoteState>, StorageError> {
        storage::EmbeddedStore::crdt_remote_state(self, table, id, field, kind)
    }
    fn crdt_remote_effect(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
        prior_payloads: &[Vec<u8>],
        payload: &[u8],
    ) -> Result<storage::CrdtRemoteEffect, StorageError> {
        storage::EmbeddedStore::crdt_remote_effect(
            self,
            table,
            id,
            field,
            kind,
            prior_payloads,
            payload,
        )
    }
    fn crdt_read_states(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtReadState>, StorageError> {
        storage::EmbeddedStore::crdt_read_states(self, table, id)
    }
    fn crdt_snapshot_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtSnapshot>, StorageError> {
        storage::EmbeddedStore::crdt_snapshot_read(self, table, id)
    }
    #[cfg(not(target_arch = "wasm32"))]
    fn remote_pull_page_queue(&self, pull: RemotePull) -> RemoteStoreFuture<RemotePullResult> {
        let store = std::sync::Arc::clone(self);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || store.remote_pull_page(&pull))
                .await
                .map_err(|error| {
                    StorageError::Unsatisfiable(format!(
                        "projection storage task terminated: {error}"
                    ))
                })?
        })
    }
    fn remote_subscription_delete_queue(
        &self,
        subscription: String,
        now_ms: i64,
    ) -> RemoteStoreFuture<RemotePullResult> {
        let store = std::sync::Arc::clone(self);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                store.remote_subscription_delete(&subscription, now_ms)
            })
            .await
            .map_err(|error| {
                StorageError::Unsatisfiable(format!("projection storage task terminated: {error}"))
            })?
        })
    }
}

impl<S: RemoteStore + ?Sized> RemoteStore for Box<S> {
    fn store_job_count(&self) -> usize {
        self.as_ref().store_job_count()
    }
    fn schema_table_names(&self) -> Result<Vec<String>, StorageError> {
        self.as_ref().schema_table_names()
    }
    fn identity_write(
        &self,
        identity_key: &str,
        identity_json: Option<&str>,
    ) -> Result<(), StorageError> {
        self.as_ref().identity_write(identity_key, identity_json)
    }
    fn upload_has_pending(&self) -> Result<bool, StorageError> {
        self.as_ref().upload_has_pending()
    }
    fn upload_lease_write(
        &self,
        args: UploadLeaseWrite,
    ) -> Result<Option<PendingUpload>, StorageError> {
        self.as_ref().upload_lease_write(args)
    }
    fn upload_complete(
        &self,
        local_storage_id: &str,
        owner: &str,
        convex_id: &str,
        now_ms: i64,
    ) -> Result<bool, StorageError> {
        self.as_ref()
            .upload_complete(local_storage_id, owner, convex_id, now_ms)
    }
    fn blob_read(&self, key: &str) -> Result<Option<Vec<u8>>, StorageError> {
        self.as_ref().blob_read(key)
    }
    fn blob_write(&self, key: &str, bytes: Vec<u8>) -> Result<(), StorageError> {
        self.as_ref().blob_write(key, bytes)
    }
    fn id_read(&self, table: &str, local_id: &str) -> Result<Option<IdMapping>, StorageError> {
        self.as_ref().id_read(table, local_id)
    }
    fn id_local_read(
        &self,
        table: &str,
        server_document_id: &str,
    ) -> Result<Option<String>, StorageError> {
        self.as_ref().id_local_read(table, server_document_id)
    }
    fn projection_read(
        &self,
        table: &str,
        local_id: &str,
    ) -> Result<Option<RowHead>, StorageError> {
        self.as_ref().projection_read(table, local_id)
    }
    fn remote_read_cursor(&self, subscription: &str) -> Result<Option<String>, StorageError> {
        self.as_ref().remote_read_cursor(subscription)
    }
    fn remote_progress_has(&self) -> Result<bool, StorageError> {
        self.as_ref().remote_progress_has()
    }
    fn remote_subscription_read(&self) -> Result<Vec<String>, StorageError> {
        self.as_ref().remote_subscription_read()
    }
    fn remote_push_envelope_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        self.as_ref().remote_push_envelope_read(num_items)
    }
    fn remote_push_settle(
        &self,
        settlement: &RemotePushSettlement,
    ) -> Result<RemotePushSettlementResult, StorageError> {
        self.as_ref().remote_push_settle(settlement)
    }
    fn remote_settlement_ack_read(&self, num_items: usize) -> Result<Vec<String>, StorageError> {
        self.as_ref().remote_settlement_ack_read(num_items)
    }
    fn remote_settlement_ack_complete(&self, mutation_ids: &[String]) -> Result<(), StorageError> {
        self.as_ref().remote_settlement_ack_complete(mutation_ids)
    }
    fn crdt_remote_state(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
    ) -> Result<Option<storage::CrdtRemoteState>, StorageError> {
        self.as_ref().crdt_remote_state(table, id, field, kind)
    }
    fn crdt_remote_effect(
        &self,
        table: &str,
        id: &str,
        field: &str,
        kind: storage::CrdtFieldKind,
        prior_payloads: &[Vec<u8>],
        payload: &[u8],
    ) -> Result<storage::CrdtRemoteEffect, StorageError> {
        self.as_ref()
            .crdt_remote_effect(table, id, field, kind, prior_payloads, payload)
    }
    fn crdt_read_states(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtReadState>, StorageError> {
        self.as_ref().crdt_read_states(table, id)
    }
    fn crdt_snapshot_read(
        &self,
        table: &str,
        id: &str,
    ) -> Result<Vec<storage::CrdtSnapshot>, StorageError> {
        self.as_ref().crdt_snapshot_read(table, id)
    }
    fn remote_pull_page_queue(&self, pull: RemotePull) -> RemoteStoreFuture<RemotePullResult> {
        self.as_ref().remote_pull_page_queue(pull)
    }
    fn remote_subscription_delete_queue(
        &self,
        subscription: String,
        now_ms: i64,
    ) -> RemoteStoreFuture<RemotePullResult> {
        self.as_ref()
            .remote_subscription_delete_queue(subscription, now_ms)
    }
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use std::sync::{Arc, Mutex};

    use storage::CrdtFieldKind;

    use super::*;

    #[derive(Default)]
    struct RecordingStore {
        calls: Arc<Mutex<Vec<&'static str>>>,
    }

    impl RecordingStore {
        fn record(&self, name: &'static str) {
            self.calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(name);
        }

        fn unsatisfiable() -> StorageError {
            StorageError::Unsatisfiable("recording stub".to_owned())
        }
    }

    impl RemoteStore for RecordingStore {
        fn store_job_count(&self) -> usize {
            self.record("store_job_count");
            0
        }
        fn schema_table_names(&self) -> Result<Vec<String>, StorageError> {
            self.record("schema_table_names");
            Ok(Vec::new())
        }
        fn identity_write(
            &self,
            _identity_key: &str,
            _identity_json: Option<&str>,
        ) -> Result<(), StorageError> {
            self.record("identity_write");
            Ok(())
        }
        fn upload_has_pending(&self) -> Result<bool, StorageError> {
            self.record("upload_has_pending");
            Ok(false)
        }
        fn upload_lease_write(
            &self,
            _args: UploadLeaseWrite,
        ) -> Result<Option<PendingUpload>, StorageError> {
            self.record("upload_lease_write");
            Ok(None)
        }
        fn upload_complete(
            &self,
            _local_storage_id: &str,
            _owner: &str,
            _convex_id: &str,
            _now_ms: i64,
        ) -> Result<bool, StorageError> {
            self.record("upload_complete");
            Ok(false)
        }
        fn blob_read(&self, _key: &str) -> Result<Option<Vec<u8>>, StorageError> {
            self.record("blob_read");
            Ok(None)
        }
        fn blob_write(&self, _key: &str, _bytes: Vec<u8>) -> Result<(), StorageError> {
            self.record("blob_write");
            Ok(())
        }
        fn id_read(
            &self,
            _table: &str,
            _local_id: &str,
        ) -> Result<Option<IdMapping>, StorageError> {
            self.record("id_read");
            Ok(None)
        }
        fn id_local_read(
            &self,
            _table: &str,
            _server_document_id: &str,
        ) -> Result<Option<String>, StorageError> {
            self.record("id_local_read");
            Ok(None)
        }
        fn projection_read(
            &self,
            _table: &str,
            _local_id: &str,
        ) -> Result<Option<RowHead>, StorageError> {
            self.record("projection_read");
            Ok(None)
        }
        fn remote_read_cursor(&self, _subscription: &str) -> Result<Option<String>, StorageError> {
            self.record("remote_read_cursor");
            Ok(None)
        }
        fn remote_progress_has(&self) -> Result<bool, StorageError> {
            self.record("remote_progress_has");
            Ok(false)
        }
        fn remote_subscription_read(&self) -> Result<Vec<String>, StorageError> {
            self.record("remote_subscription_read");
            Ok(Vec::new())
        }
        fn remote_push_envelope_read(
            &self,
            _num_items: usize,
        ) -> Result<Vec<String>, StorageError> {
            self.record("remote_push_envelope_read");
            Ok(Vec::new())
        }
        fn remote_push_settle(
            &self,
            _settlement: &RemotePushSettlement,
        ) -> Result<RemotePushSettlementResult, StorageError> {
            self.record("remote_push_settle");
            Err(Self::unsatisfiable())
        }
        fn remote_settlement_ack_read(
            &self,
            _num_items: usize,
        ) -> Result<Vec<String>, StorageError> {
            self.record("remote_settlement_ack_read");
            Ok(Vec::new())
        }
        fn remote_settlement_ack_complete(
            &self,
            _mutation_ids: &[String],
        ) -> Result<(), StorageError> {
            self.record("remote_settlement_ack_complete");
            Ok(())
        }
        fn crdt_remote_state(
            &self,
            _table: &str,
            _id: &str,
            _field: &str,
            _kind: CrdtFieldKind,
        ) -> Result<Option<storage::CrdtRemoteState>, StorageError> {
            self.record("crdt_remote_state");
            Ok(None)
        }
        fn crdt_remote_effect(
            &self,
            _table: &str,
            _id: &str,
            _field: &str,
            _kind: CrdtFieldKind,
            _prior_payloads: &[Vec<u8>],
            _payload: &[u8],
        ) -> Result<storage::CrdtRemoteEffect, StorageError> {
            self.record("crdt_remote_effect");
            Err(Self::unsatisfiable())
        }
        fn crdt_read_states(
            &self,
            _table: &str,
            _id: &str,
        ) -> Result<Vec<storage::CrdtReadState>, StorageError> {
            self.record("crdt_read_states");
            Ok(Vec::new())
        }
        fn crdt_snapshot_read(
            &self,
            _table: &str,
            _id: &str,
        ) -> Result<Vec<storage::CrdtSnapshot>, StorageError> {
            self.record("crdt_snapshot_read");
            Ok(Vec::new())
        }
        fn remote_pull_page_queue(&self, _pull: RemotePull) -> RemoteStoreFuture<RemotePullResult> {
            self.record("remote_pull_page_queue");
            Box::pin(async { Err(Self::unsatisfiable()) })
        }
        fn remote_subscription_delete_queue(
            &self,
            _subscription: String,
            _now_ms: i64,
        ) -> RemoteStoreFuture<RemotePullResult> {
            self.record("remote_subscription_delete_queue");
            Box::pin(async { Err(Self::unsatisfiable()) })
        }
    }

    const EVERY_METHOD: [&str; 24] = [
        "store_job_count",
        "schema_table_names",
        "identity_write",
        "upload_has_pending",
        "upload_lease_write",
        "upload_complete",
        "blob_read",
        "blob_write",
        "id_read",
        "id_local_read",
        "projection_read",
        "remote_read_cursor",
        "remote_progress_has",
        "remote_subscription_read",
        "remote_push_envelope_read",
        "remote_push_settle",
        "remote_settlement_ack_read",
        "remote_settlement_ack_complete",
        "crdt_remote_state",
        "crdt_remote_effect",
        "crdt_read_states",
        "crdt_snapshot_read",
        "remote_pull_page_queue",
        "remote_subscription_delete_queue",
    ];

    #[tokio::test]
    #[allow(
        clippy::let_underscore_must_use,
        reason = "the test asserts delegation via the recorder, not the forwarded return values"
    )]
    async fn boxed_store_forwards_every_remote_store_method() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let boxed: Box<dyn RemoteStore> = Box::new(RecordingStore {
            calls: Arc::clone(&calls),
        });

        let _ = boxed.store_job_count();
        let _ = boxed.schema_table_names();
        let _ = boxed.identity_write("k", None);
        let _ = boxed.upload_has_pending();
        let _ = boxed.upload_lease_write(UploadLeaseWrite::Claim {
            owner: String::new(),
            now_ms: 0,
            lease_until: 0,
        });
        let _ = boxed.upload_complete("l", "o", "c", 0);
        let _ = boxed.blob_read("k");
        let _ = boxed.blob_write("k", Vec::new());
        let _ = boxed.id_read("t", "l");
        let _ = boxed.id_local_read("t", "s");
        let _ = boxed.projection_read("t", "l");
        let _ = boxed.remote_read_cursor("s");
        let _ = boxed.remote_progress_has();
        let _ = boxed.remote_subscription_read();
        let _ = boxed.remote_push_envelope_read(1);
        let _ = boxed.remote_push_settle(&RemotePushSettlement {
            mutation_id: String::new(),
            expected_commit_seq: 0,
            now_ms: 0,
            outcome: storage::RemotePushSettlementOutcome::Rejected {
                schedules: Vec::new(),
                targets: Vec::new(),
                projections: Vec::new(),
            },
        });
        let _ = boxed.remote_settlement_ack_read(1);
        let _ = boxed.remote_settlement_ack_complete(&[]);
        let _ = boxed.crdt_remote_state("t", "i", "f", CrdtFieldKind::Text);
        let _ = boxed.crdt_remote_effect("t", "i", "f", CrdtFieldKind::Text, &[], &[]);
        let _ = boxed.crdt_read_states("t", "i");
        let _ = boxed.crdt_snapshot_read("t", "i");
        let _ = boxed
            .remote_pull_page_queue(RemotePull {
                subscription: String::new(),
                members: Vec::new(),
                projections: Vec::new(),
                crdt: Vec::new(),
                blobs: Vec::new(),
                cursor: None,
                received_time: 0,
                result: None,
            })
            .await;
        let _ = boxed
            .remote_subscription_delete_queue(String::new(), 0)
            .await;

        let recorded = calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        for method in EVERY_METHOD {
            assert!(
                recorded.contains(&method),
                "Box<S> did not forward {method}"
            );
        }
        assert_eq!(recorded.len(), EVERY_METHOD.len());
    }
}
