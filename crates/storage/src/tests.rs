use crate::clock::Clock;
use crate::{
    Affinity, Bound, ColValue, ColumnDef, CountSpec, DeleteIn, EmbeddedStore, IndexDef, Order,
    ReadOutcome, ScanSpec, StorageError, StoreSchema, TableDef, UpsertIn, WriteBatch,
};

#[test]
fn clock_is_strictly_increasing_within_a_wall_instant() {
    let mut c = Clock::new();
    let a = c.now(1000.0);
    let b = c.now(1000.0);
    let d = c.now(1000.0);
    assert!((a - 1000.0).abs() < f64::EPSILON);
    assert!(a < b && b < d);
}

#[test]
fn clock_never_goes_backward_on_a_stepped_back_wall() {
    let mut c = Clock::new();
    let a = c.now(5000.0);
    let b = c.now(4000.0);
    assert!(b > a);
}

#[test]
fn clock_observe_floors_to_the_high_water_mark() {
    let mut c = Clock::new();
    c.observe(9000.0);
    assert!(c.now(1000.0) >= 9000.0);
}

fn tmp_path(name: &str) -> std::path::PathBuf {
    let p = std::env::temp_dir().join(name);
    for suffix in ["", "-wal", "-shm"] {
        std::fs::remove_file(p.with_file_name(format!("{name}{suffix}"))).ok();
    }
    p
}

fn schema() -> StoreSchema {
    StoreSchema {
        tables: vec![
            TableDef {
                name: "issues".into(),
                columns: vec![ColumnDef {
                    name: "status".into(),
                    affinity: Affinity::Text,
                }],
                indexes: vec![IndexDef {
                    name: "by_status".into(),
                    fields: vec!["status".into()],
                }],
            },
            TableDef {
                name: "t".into(),
                columns: vec![],
                indexes: vec![],
            },
        ],
    }
}

fn bool_schema() -> StoreSchema {
    StoreSchema {
        tables: vec![TableDef {
            name: "flags".into(),
            columns: vec![ColumnDef {
                name: "active".into(),
                affinity: Affinity::Integer,
            }],
            indexes: vec![IndexDef {
                name: "by_active".into(),
                fields: vec!["active".into()],
            }],
        }],
    }
}

fn issue(store: &EmbeddedStore, id: &str, title: &str, status: &str) -> UpsertIn {
    UpsertIn {
        table: "issues".into(),
        id: id.into(),
        data: format!(r#"{{"title":"{title}"}}"#),
        cols: vec![("status".into(), ColValue::Text(status.into()))],
        creation_time: store.next_creation_time().unwrap(),
    }
}

fn flag(store: &EmbeddedStore, id: &str, active: ColValue) -> UpsertIn {
    UpsertIn {
        table: "flags".into(),
        id: id.into(),
        data: r#"{"active":true}"#.into(),
        cols: vec![("active".into(), active)],
        creation_time: store.next_creation_time().unwrap(),
    }
}

#[tokio::test]
async fn round_trips_and_persists() {
    let path = tmp_path("rs_roundtrip.db");
    let p = path.to_str().unwrap();

    let first_ct;
    {
        let store = EmbeddedStore::open(p).await.unwrap();
        store.setup(schema()).await.unwrap();
        let up = issue(&store, "i1", "hello", "open");
        first_ct = up.creation_time;
        store
            .commit(WriteBatch {
                upserts: vec![up],
                deletes: vec![],
            })
            .await
            .unwrap();

        let got = store.get("issues", "i1").await.unwrap().expect("row");
        assert_eq!(got.id, "i1");
        assert!(got.creation_time.is_finite());
        assert!(got.data.contains("hello"));
        assert!(store.get("issues", "missing").await.unwrap().is_none());
    }

    let store = EmbeddedStore::open(p).await.unwrap();
    store.setup(schema()).await.unwrap();
    assert_eq!(
        store
            .get("issues", "i1")
            .await
            .unwrap()
            .expect("persists across reopen")
            .id,
        "i1"
    );

    let up2 = issue(&store, "i2", "world", "open");
    let second_ct = up2.creation_time;
    store
        .commit(WriteBatch {
            upserts: vec![up2],
            deletes: vec![],
        })
        .await
        .unwrap();
    // The clock recovered the high-water mark on reopen, so the second write is strictly later.
    assert!(second_ct > first_ct);

    let all = store
        .scan(&ScanSpec {
            table: "issues".into(),
            order: Order::Asc,
            ..Default::default()
        })
        .await
        .unwrap()
        .into_option()
        .unwrap();
    assert_eq!(all.len(), 2);
}

#[tokio::test]
async fn identity_keys_are_isolated() {
    let path = tmp_path("rs_identity.db");
    let p = path.to_str().unwrap();
    let a = EmbeddedStore::open_with_identity_key(p, "a").await.unwrap();
    let b = EmbeddedStore::open_with_identity_key(p, "b").await.unwrap();
    a.setup(schema()).await.unwrap();
    b.setup(schema()).await.unwrap();

    a.commit(WriteBatch {
        upserts: vec![issue(&a, "same", "A", "open")],
        deletes: vec![],
    })
    .await
    .unwrap();
    b.commit(WriteBatch {
        upserts: vec![issue(&b, "same", "B", "closed")],
        deletes: vec![],
    })
    .await
    .unwrap();

    assert!(a
        .get("issues", "same")
        .await
        .unwrap()
        .expect("a row")
        .data
        .contains('A'));
    assert!(b
        .get("issues", "same")
        .await
        .unwrap()
        .expect("b row")
        .data
        .contains('B'));
}

#[tokio::test]
async fn setup_rejects_invalid_and_reserved_schema_names() {
    let store = EmbeddedStore::open(tmp_path("rs_idents.db").to_str().unwrap())
        .await
        .unwrap();
    for name in ["issues; DROP TABLE x", "", "1abc"] {
        let bad = StoreSchema {
            tables: vec![TableDef {
                name: name.into(),
                columns: vec![],
                indexes: vec![],
            }],
        };
        assert!(matches!(
            store.setup(bad).await,
            Err(StorageError::InvalidIdent(_))
        ));
    }
    let reserved = StoreSchema {
        tables: vec![TableDef {
            name: "issues".into(),
            columns: vec![ColumnDef {
                name: "data".into(),
                affinity: Affinity::Text,
            }],
            indexes: vec![],
        }],
    };
    assert!(matches!(
        store.setup(reserved).await,
        Err(StorageError::ReservedColumn(name)) if name == "data"
    ));
}

#[tokio::test]
async fn commit_applies_mixed_batch_and_rolls_back_failed_writes() {
    let store = EmbeddedStore::open(tmp_path("rs_commit.db").to_str().unwrap())
        .await
        .unwrap();
    store.setup(bool_schema()).await.unwrap();
    store
        .commit(WriteBatch {
            upserts: vec![
                flag(&store, "keep", ColValue::Bool(true)),
                flag(&store, "remove", ColValue::Bool(false)),
            ],
            deletes: vec![],
        })
        .await
        .unwrap();
    store
        .commit(WriteBatch {
            upserts: vec![flag(&store, "new", ColValue::Bool(true))],
            deletes: vec![DeleteIn {
                table: "flags".into(),
                id: "remove".into(),
            }],
        })
        .await
        .unwrap();
    assert!(store.get("flags", "new").await.unwrap().is_some());
    assert!(store.get("flags", "remove").await.unwrap().is_none());

    // Relies on SQLite STRICT-mode type rejection to fail the second row mid-batch.
    let err = store
        .commit(WriteBatch {
            upserts: vec![
                flag(&store, "rolled", ColValue::Bool(true)),
                flag(&store, "bad", ColValue::Text("not-an-integer".into())),
            ],
            deletes: vec![],
        })
        .await;
    assert!(matches!(err, Err(StorageError::Turso(_))));
    assert!(store.get("flags", "rolled").await.unwrap().is_none());
}

#[tokio::test]
async fn scans_by_index_bound_and_counts() {
    let store = EmbeddedStore::open(tmp_path("rs_index.db").to_str().unwrap())
        .await
        .unwrap();
    store.setup(schema()).await.unwrap();
    store
        .commit(WriteBatch {
            upserts: vec![
                issue(&store, "a", "A", "open"),
                issue(&store, "b", "B", "closed"),
                issue(&store, "c", "C", "open"),
            ],
            deletes: vec![],
        })
        .await
        .unwrap();

    let only_open = store
        .scan(&ScanSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("open".into()),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .await
        .unwrap()
        .into_option()
        .unwrap();
    let ids: Vec<String> = only_open.into_iter().map(|d| d.id).collect();
    assert_eq!(ids, vec!["a", "c"]);

    assert_eq!(
        store
            .count(&CountSpec {
                table: "issues".into(),
                ..Default::default()
            })
            .await
            .unwrap(),
        ReadOutcome::Executed(3)
    );
    assert_eq!(
        store
            .count(&CountSpec {
                table: "issues".into(),
                index: Some("by_status".into()),
                bounds: Some(vec![Bound::Eq {
                    value: ColValue::Text("open".into()),
                }]),
            })
            .await
            .unwrap(),
        ReadOutcome::Executed(2)
    );
}

#[tokio::test]
async fn scans_boolean_index_values() {
    let store = EmbeddedStore::open(tmp_path("rs_bool.db").to_str().unwrap())
        .await
        .unwrap();
    store.setup(bool_schema()).await.unwrap();
    store
        .commit(WriteBatch {
            upserts: vec![
                UpsertIn {
                    table: "flags".into(),
                    id: "yes".into(),
                    data: r#"{"active":true}"#.into(),
                    cols: vec![("active".into(), ColValue::Bool(true))],
                    creation_time: store.next_creation_time().unwrap(),
                },
                UpsertIn {
                    table: "flags".into(),
                    id: "no".into(),
                    data: r#"{"active":false}"#.into(),
                    cols: vec![("active".into(), ColValue::Bool(false))],
                    creation_time: store.next_creation_time().unwrap(),
                },
            ],
            deletes: vec![],
        })
        .await
        .unwrap();

    let active = store
        .scan(&ScanSpec {
            table: "flags".into(),
            index: Some("by_active".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Bool(true),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .await
        .unwrap()
        .into_option()
        .unwrap();
    let ids: Vec<String> = active.into_iter().map(|d| d.id).collect();
    assert_eq!(ids, vec!["yes"]);
}

#[tokio::test]
async fn unsupported_plan_and_unsatisfiable() {
    let store = EmbeddedStore::open(tmp_path("rs_miss.db").to_str().unwrap())
        .await
        .unwrap();
    store.setup(schema()).await.unwrap();

    // Unknown index => unsupported read plan.
    let miss = store
        .scan(&ScanSpec {
            table: "issues".into(),
            index: Some("nope".into()),
            order: Order::Asc,
            ..Default::default()
        })
        .await
        .unwrap();
    assert!(matches!(miss, ReadOutcome::Unsupported));

    // limit > cap => Unsatisfiable.
    let err = store
        .scan(&ScanSpec {
            table: "issues".into(),
            order: Order::Asc,
            limit: Some(40_000),
            ..Default::default()
        })
        .await;
    assert!(matches!(err, Err(StorageError::Unsatisfiable(_))));
}
