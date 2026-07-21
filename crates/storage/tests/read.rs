//! read — migrated from the former inline `src/tests.rs`, reaching private internals only
//! through `storage::testkit`. Run with `--features testkit`.
#![cfg(feature = "testkit")]
#![allow(
    clippy::too_many_lines,
    clippy::unreadable_literal,
    clippy::similar_names
)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use storage::testkit::*;
use storage::*;

thread_local! {
    static ALLOCATED: Cell<usize> = const { Cell::new(0) };
}

struct Counting;

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATED.with(|c| c.set(c.get().wrapping_add(layout.size())));
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Bytes allocated on the current thread while running `f`.
fn measure<R>(f: impl FnOnce() -> R) -> (usize, R) {
    let start = ALLOCATED.with(Cell::get);
    let result = f();
    (ALLOCATED.with(Cell::get).wrapping_sub(start), result)
}

#[test]
fn read_page_by_index_bound_and_counts() {
    let store = EmbeddedStore::open(tmp_path("rs_index.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(
        &store,
        doc_writes(vec![
            issue(&store, "a", "A", "open"),
            issue(&store, "b", "B", "closed"),
            issue(&store, "c", "C", "open"),
        ]),
    );

    let only_open = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("open".into()),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&only_open), vec!["a", "c"]);

    assert_eq!(
        store
            .doc_count_read(&CountSpec {
                table: "issues".into(),
                ..Default::default()
            })
            .unwrap(),
        Some(3)
    );
    assert_eq!(
        store
            .doc_count_read(&CountSpec {
                table: "issues".into(),
                index: Some("by_status".into()),
                bounds: Some(vec![Bound::Eq {
                    value: ColValue::Text("open".into()),
                }]),
            })
            .unwrap(),
        Some(2)
    );
}

#[test]
fn read_page_boolean_index_values() {
    let store = EmbeddedStore::open(tmp_path("rs_bool.db").to_str().unwrap()).unwrap();
    store.setup(&bool_schema()).unwrap();
    commit(
        &store,
        doc_writes(vec![
            DocWrite {
                table: "flags".into(),
                id: "yes".into(),
                data: r#"{"active":true}"#.into(),
                cols: vec![("active".into(), ColValue::Bool(true))],
                creation_time: store.clock_read().unwrap(),
            },
            DocWrite {
                table: "flags".into(),
                id: "no".into(),
                data: r#"{"active":false}"#.into(),
                cols: vec![("active".into(), ColValue::Bool(false))],
                creation_time: store.clock_read().unwrap(),
            },
        ]),
    );

    let active = store
        .doc_page_read(&ReadSpec {
            table: "flags".into(),
            index: Some("by_active".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Bool(true),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&active), vec!["yes"]);
}

#[test]
fn plans_convex_fields_through_storage_columns() {
    let store = EmbeddedStore::open(tmp_path("rs_aliases.db").to_str().unwrap()).unwrap();
    store.setup(&alias_schema()).unwrap();
    let first = user(&store, "users|a", "a@example.com");
    let first_creation_time = first.creation_time;
    commit(
        &store,
        doc_writes(vec![first, user(&store, "users|b", "b@example.com")]),
    );

    let by_email = store
        .doc_page_read(&ReadSpec {
            table: "users".into(),
            index: Some("by_email".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("b@example.com".into()),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_email), vec!["users|b"]);

    let by_creation_time = store
        .doc_page_read(&ReadSpec {
            table: "users".into(),
            index: Some("by_creation_time".into()),
            bounds: Some(vec![Bound::Range {
                lower: Some(ColValue::Real(first_creation_time)),
                lower_inclusive: true,
                upper: None,
                upper_inclusive: false,
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_creation_time), vec!["users|a", "users|b"]);

    let by_id = store
        .doc_page_read(&ReadSpec {
            table: "users".into(),
            index: Some("by_id".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Text("users|a".into()),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_id), vec!["users|a"]);
}

#[test]
fn read_page_total_with_exact_null_and_undefined() {
    let store = EmbeddedStore::open(tmp_path("rs_total.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let missing = DocWrite {
        table: "issues".into(),
        id: "missing".into(),
        data: r#"{"title":"M"}"#.into(),
        cols: vec![],
        creation_time: store.clock_read().unwrap(),
    };
    let explicit_null = DocWrite {
        table: "issues".into(),
        id: "null".into(),
        data: r#"{"title":"N","status":null}"#.into(),
        cols: vec![("status".into(), ColValue::Null)],
        creation_time: store.clock_read().unwrap(),
    };
    commit(
        &store,
        doc_writes(vec![
            issue(&store, "open", "O", "open"),
            missing,
            explicit_null,
        ]),
    );

    let unknown = store.doc_page_read(&ReadSpec {
        table: "issues".into(),
        index: Some("nope".into()),
        order: Order::Asc,
        ..Default::default()
    });
    assert!(matches!(unknown, Err(StorageError::Unsatisfiable(_))));

    let by_null = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Null,
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_null), vec!["null"]);

    let by_undefined = store
        .doc_page_read(&ReadSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Undefined,
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&by_undefined), vec!["missing"]);

    let null_count = store
        .doc_count_read(&CountSpec {
            table: "issues".into(),
            index: Some("by_status".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Null,
            }]),
        })
        .unwrap();
    assert_eq!(null_count, Some(1));

    let err = store.doc_page_read(&ReadSpec {
        table: "issues".into(),
        order: Order::Asc,
        page_size: Some(40_000),
        ..Default::default()
    });
    assert!(matches!(err, Err(StorageError::Unsatisfiable(_))));
}

#[test]
fn paged_scans_walk_the_cursor_chain() {
    let store = EmbeddedStore::open(tmp_path("rs_paging.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let rows: Vec<DocWrite> = (0..10)
        .map(|i| {
            issue(
                &store,
                &format!("i{i}"),
                &format!("issue {i}"),
                if i % 2 == 0 { "open" } else { "closed" },
            )
        })
        .collect();
    commit(&store, doc_writes(rows));

    let full = |order: Order| {
        doc_ids(
            &store
                .doc_page_read(&ReadSpec {
                    table: "issues".into(),
                    order,
                    ..Default::default()
                })
                .unwrap(),
        )
    };

    for order in [Order::Asc, Order::Desc] {
        let spec = ReadSpec {
            table: "issues".into(),
            order,
            ..Default::default()
        };
        for page_size in [1, 3, 10, 11] {
            assert_eq!(paged_ids(&store, &spec, page_size), full(order));
        }
    }

    let bounded = ReadSpec {
        table: "issues".into(),
        index: Some("by_status".into()),
        bounds: Some(vec![Bound::Eq {
            value: ColValue::Text("open".into()),
        }]),
        order: Order::Asc,
        ..Default::default()
    };
    assert_eq!(
        paged_ids(&store, &bounded, 2),
        vec!["i0", "i2", "i4", "i6", "i8"]
    );
}

#[test]
fn paged_scans_handle_null_key_columns() {
    let store = EmbeddedStore::open(tmp_path("rs_paging_nulls.db").to_str().unwrap()).unwrap();
    store.setup(&alias_schema()).unwrap();
    let mut rows = Vec::new();
    for i in 0..4 {
        rows.push(user_without_email(&store, &format!("users|n{i}")));
    }
    for i in 0..4 {
        rows.push(user(&store, &format!("users|e{i}"), &format!("u{i}@x.com")));
    }
    commit(&store, doc_writes(rows));

    for order in [Order::Asc, Order::Desc] {
        let spec = ReadSpec {
            table: "users".into(),
            index: Some("by_email".into()),
            order,
            ..Default::default()
        };
        let full = doc_ids(&store.doc_page_read(&spec).unwrap());
        assert_eq!(full.len(), 8);
        for page_size in [1, 3, 5] {
            assert_eq!(paged_ids(&store, &spec, page_size), full, "{order:?}");
        }
    }
}

#[test]
fn cursors_reject_a_different_scan_shape_and_resume_after_key_works() {
    let store = EmbeddedStore::open(tmp_path("rs_cursor_shape.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    commit(
        &store,
        doc_writes(vec![
            issue(&store, "a", "A", "open"),
            issue(&store, "b", "B", "open"),
            issue(&store, "c", "C", "open"),
        ]),
    );

    let spec = ReadSpec {
        table: "issues".into(),
        order: Order::Asc,
        page_size: Some(2),
        ..Default::default()
    };
    let first = store.doc_page_read(&spec).unwrap();
    let cursor = first.cursor.clone().expect("has next page");

    let mismatched = store.doc_page_read(&ReadSpec {
        order: Order::Desc,
        cursor: Some(cursor.clone()),
        ..spec.clone()
    });
    assert!(matches!(mismatched, Err(StorageError::InvalidCursor(_))));

    let docs = parse_docs(&first);
    let last = docs.last().unwrap();
    let resumed = store
        .doc_page_read(&ReadSpec {
            cursor: None,
            resume_after_key: Some(vec![
                ColValue::Real(last["_creationTime"].as_f64().unwrap()),
                ColValue::Text(last["_id"].as_str().unwrap().to_owned()),
            ]),
            ..spec.clone()
        })
        .unwrap();
    assert_eq!(doc_ids(&resumed), vec!["c"]);
    assert!(resumed.cursor.is_none());

    let both = store.doc_page_read(&ReadSpec {
        cursor: Some(cursor),
        resume_after_key: Some(vec![ColValue::Null, ColValue::Null]),
        ..spec
    });
    assert!(matches!(both, Err(StorageError::InvalidCursor(_))));
}

#[test]
fn malformed_cursors_return_errors_instead_of_panicking() {
    let bad_tag_boundary = decode_cursor("ec1:1:xé", "x");
    assert!(matches!(
        bad_tag_boundary,
        Err(StorageError::InvalidCursor(_))
    ));

    let bad_real_boundary = decode_cursor("ec1:1:xf000000000000000é", "x");
    assert!(matches!(
        bad_real_boundary,
        Err(StorageError::InvalidCursor(_))
    ));
}

#[test]
fn order_key_matches_convex_total_order() {
    let store = EmbeddedStore::open(tmp_path("rs_orderkey.db").to_str().unwrap()).unwrap();
    store.setup(&vals_schema()).unwrap();

    let ordered: Vec<(&str, Option<ColValue>)> = vec![
        ("00_undef", None),
        ("01_null", Some(ColValue::Null)),
        ("02_int_neg", Some(ColValue::Integer(-5))),
        ("03_int_pos", Some(ColValue::Integer(10))),
        ("04_real_negzero", Some(ColValue::Real(-0.0))),
        ("05_real_zero", Some(ColValue::Real(0.0))),
        ("06_real_small", Some(ColValue::Real(1.5))),
        ("07_real_inf", Some(ColValue::Real(f64::INFINITY))),
        ("08_real_nan", Some(ColValue::Real(f64::NAN))),
        ("09_bool_false", Some(ColValue::Bool(false))),
        ("10_bool_true", Some(ColValue::Bool(true))),
        ("11_text_a", Some(ColValue::Text("a".into()))),
        ("12_text_b", Some(ColValue::Text("b".into()))),
    ];
    let rows: Vec<DocWrite> = ordered
        .iter()
        .rev()
        .map(|(id, v)| DocWrite {
            table: "vals".into(),
            id: (*id).to_owned(),
            data: "{}".into(),
            cols: v
                .clone()
                .map(|v| vec![("v".to_owned(), v)])
                .unwrap_or_default(),
            creation_time: store.clock_read().unwrap(),
        })
        .collect();
    commit(&store, doc_writes(rows));

    let asc = store
        .doc_page_read(&ReadSpec {
            table: "vals".into(),
            index: Some("by_v".into()),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    let expected: Vec<&str> = ordered.iter().map(|(id, _)| *id).collect();
    assert_eq!(doc_ids(&asc), expected, "ascending order must match Convex");

    let neg_zero = store
        .doc_page_read(&ReadSpec {
            table: "vals".into(),
            index: Some("by_v".into()),
            bounds: Some(vec![Bound::Eq {
                value: ColValue::Real(-0.0),
            }]),
            order: Order::Asc,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(doc_ids(&neg_zero), vec!["04_real_negzero"]);
}

#[test]
fn cursor_rejects_a_different_bound_value() {
    let store = EmbeddedStore::open(tmp_path("rs_cursor_value.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    let rows: Vec<DocWrite> = (0..6)
        .map(|i| {
            issue(
                &store,
                &format!("i{i}"),
                "t",
                if i < 3 { "open" } else { "closed" },
            )
        })
        .collect();
    commit(&store, doc_writes(rows));

    let open = ReadSpec {
        table: "issues".into(),
        index: Some("by_status".into()),
        bounds: Some(vec![Bound::Eq {
            value: ColValue::Text("open".into()),
        }]),
        order: Order::Asc,
        page_size: Some(2),
        ..Default::default()
    };
    let page = store.doc_page_read(&open).unwrap();
    let cursor = page.cursor.clone().expect("has next page");

    let closed = store.doc_page_read(&ReadSpec {
        bounds: Some(vec![Bound::Eq {
            value: ColValue::Text("closed".into()),
        }]),
        cursor: Some(cursor.clone()),
        ..open.clone()
    });
    assert!(matches!(closed, Err(StorageError::InvalidCursor(_))));

    let resumed = store
        .doc_page_read(&ReadSpec {
            cursor: Some(cursor),
            ..open
        })
        .unwrap();
    assert_eq!(doc_ids(&resumed), vec!["i2"]);
}

#[test]
fn decode_cursor_rejects_malformed_input() {
    for bad in [
        "",
        "ec1:0:",
        "nope",
        "ec2:bad:shape",
        "ec2:999:short",
        "ec2:1:é",
        "ec2:0:f00000000000000g",
        "ec2:0:s4:é",
        "ec2:0:z",
    ] {
        assert!(
            matches!(decode_cursor(bad, ""), Err(StorageError::InvalidCursor(_))),
            "expected InvalidCursor for {bad:?}"
        );
    }
}

fn seeded_vals(rows: usize) -> EmbeddedStore {
    let store =
        EmbeddedStore::open(tmp_path(&format!("rs_alloc_{rows}.db")).to_str().unwrap()).unwrap();
    store.setup(&vals_schema()).unwrap();
    let doc_writes: Vec<DocWrite> = (0..rows)
        .map(|i| DocWrite {
            table: "vals".into(),
            id: format!("r{i:06}"),
            data: r#"{"v":0}"#.into(),
            cols: vec![("v".into(), ColValue::Integer(i as i64))],
            creation_time: store.clock_read().unwrap(),
        })
        .collect();
    store
        .commit(
            WriteBatch {
                crdt_ops: Vec::new(),
                crdt_restores: vec![],
                local_field_writes: vec![],
                local_field_deletes: vec![],
                doc_writes,
                deletes: vec![],
                fresh_ids: vec![],
                data_only_ids: vec![],
                id_mappings: vec![],
                schedules: vec![],
            },
            &CommitOptions::remote(),
        )
        .unwrap();
    store
}

fn page_spec(page_size: usize) -> ReadSpec {
    ReadSpec {
        table: "vals".into(),
        index: Some("by_v".into()),
        bounds: None,
        order: Order::Asc,
        page_size: Some(page_size),
        cursor: None,
        resume_after_key: None,
    }
}

#[test]
fn page_read_allocates_for_the_page_not_the_table() {
    let small = seeded_vals(64);
    let large = seeded_vals(4000);
    let spec = page_spec(64);

    small.doc_page_read(&spec).unwrap();
    large.doc_page_read(&spec).unwrap();

    let (small_bytes, _) = measure(|| small.doc_page_read(&spec).unwrap());
    let (large_bytes, _) = measure(|| large.doc_page_read(&spec).unwrap());

    assert!(
        large_bytes <= small_bytes.saturating_mul(3) + 4096,
        "page read allocation scales with table size: {large_bytes} B from 4000 rows vs \
         {small_bytes} B from 64 rows"
    );
}
