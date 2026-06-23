//! key — generated-input invariants of the order-key / keyset-cursor layer (proptest). The headline
//! property is cursor totality: for *any* set of rows, *any* page size, and *either* order, walking
//! the keyset-cursor chain reproduces the single-page total order exactly — no duplicates, gaps, or
//! reordering. Also: the order-key is order-preserving across the whole Convex value order
//! (undefined < null < int64 < float64 < bool < string), the cursor codec round-trips, and an exact
//! count agrees with the rows read. Run with `--features testkit`.
#![cfg(feature = "testkit")]

use std::cmp::Ordering;
use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

use proptest::prelude::*;
use storage::testkit::{decode_cursor, doc_ids, encode_cursor, paged_ids, tmp_path, vals_schema};
use storage::{
    Bound, ColValue, CommitOptions, CountSpec, EmbeddedStore, Order, ReadSpec, UpsertIn, WriteBatch,
};

/// The Convex total order, written independently from the engine so it can serve as an oracle for
/// `encode_key`: by type ordinal (undefined < null < int64 < float64 < boolean < string), then by
/// value within a type.
fn convex_cmp(a: &ColValue, b: &ColValue) -> Ordering {
    fn type_ord(v: &ColValue) -> u8 {
        match v {
            ColValue::Undefined => 0,
            ColValue::Null => 1,
            ColValue::Integer(_) => 2,
            ColValue::Real(_) => 3,
            ColValue::Bool(_) => 4,
            ColValue::Text(_) => 5,
        }
    }
    type_ord(a).cmp(&type_ord(b)).then_with(|| match (a, b) {
        (ColValue::Integer(x), ColValue::Integer(y)) => x.cmp(y),
        (ColValue::Real(x), ColValue::Real(y)) => x.partial_cmp(y).expect("finite"),
        (ColValue::Bool(x), ColValue::Bool(y)) => x.cmp(y),
        (ColValue::Text(x), ColValue::Text(y)) => x.cmp(y),
        _ => Ordering::Equal,
    })
}

static DB: AtomicUsize = AtomicUsize::new(0);

/// A fresh, uniquely-named store per generated case — fully isolated (turso has no `:memory:`, so each
/// case needs its own file so proptest shrinking can't leak state across runs).
fn fresh() -> EmbeddedStore {
    let n = DB.fetch_add(1, AtomicOrdering::Relaxed);
    let store = EmbeddedStore::open(tmp_path(&format!("prop_paging_{n}.db")).to_str().unwrap())
        .expect("open");
    store.setup(&vals_schema()).expect("setup");
    store
}

/// The full Convex value order, the column type the `by_v` index sorts on. NaN is excluded — its
/// ordering is unspecified, so it would test the harness, not the engine.
fn any_value() -> impl Strategy<Value = ColValue> {
    prop_oneof![
        Just(ColValue::Undefined),
        Just(ColValue::Null),
        any::<bool>().prop_map(ColValue::Bool),
        any::<i64>().prop_map(ColValue::Integer),
        any::<f64>()
            .prop_filter("finite", |f| f.is_finite())
            .prop_map(|f| if f == 0.0 { 0.0 } else { f })
            .prop_map(ColValue::Real),
        "[a-z0-9 _|]{0,6}".prop_map(ColValue::Text),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2048, ..ProptestConfig::default() })]

    /// The cursor codec round-trips: `decode(encode(values)) == values`. This alone would have
    /// caught the Bool/Integer cursor-tag collision.
    #[test]
    fn cursor_codec_round_trips(values in prop::collection::vec(any_value(), 0..12)) {
        let encoded = encode_cursor("by_v", &values);
        let decoded = decode_cursor(&encoded, "by_v").expect("decode");
        prop_assert_eq!(decoded, values);
    }

    /// `encode_key` is order-preserving: a `memcmp` of two order-keys matches the Convex value order.
    #[test]
    fn order_key_matches_convex_total_order(a in any_value(), b in any_value()) {
        prop_assert_eq!(
            a.encode_key().cmp(&b.encode_key()),
            convex_cmp(&a, &b),
            "encode_key disagrees with the value order for {:?} vs {:?}",
            a,
            b,
        );
    }
}

/// Build + seed a `vals` store with `(id, v)` rows via a non-`local` source.
fn seed(rows: &[(&str, ColValue)]) -> EmbeddedStore {
    let store = fresh();
    let upserts: Vec<UpsertIn> = rows
        .iter()
        .map(|(id, v)| UpsertIn {
            table: "vals".into(),
            id: (*id).into(),
            data: r#"{"v":0}"#.into(),
            cols: vec![("v".into(), v.clone())],
            creation_time: store.clock_read().expect("clock"),
        })
        .collect();
    store
        .commit(
            WriteBatch {
                crdt_ops: Vec::new(),
                crdt_restores: vec![],
                upserts,
                deletes: vec![],
                fresh_ids: vec![],
                data_only_ids: vec![],
                id_mappings: vec![],
                schedules: vec![],
            },
            &CommitOptions::remote(),
        )
        .expect("seed commit");
    store
}

/// Regression for the counterexample `cursor_paging_reproduces_the_total_order` shrank to: a keyset
/// cursor resume across a Convex *type* boundary (bool → int64) in descending order dropped the
/// trailing row. The single-page read is correct; only the paged chain lost it.
#[test]
fn descending_paging_across_value_types_keeps_every_row() {
    let store = seed(&[
        ("r0", ColValue::Text(String::new())),
        ("r1", ColValue::Bool(false)),
        ("r2", ColValue::Integer(29_157_135_342)),
    ]);
    let spec = ReadSpec {
        table: "vals".into(),
        index: Some("by_v".into()),
        bounds: None,
        order: Order::Desc,
        page_size: None,
        cursor: None,
        resume_after_key: None,
    };
    let unpaged = doc_ids(
        &store
            .doc_page_read(&ReadSpec {
                page_size: Some(10),
                ..spec.clone()
            })
            .expect("unpaged"),
    );
    assert_eq!(
        unpaged,
        vec!["r0", "r1", "r2"],
        "ground-truth descending order"
    );
    let paged = paged_ids(&store, &spec, 2);
    assert_eq!(
        paged, unpaged,
        "page_size=2 descending dropped a row at a type boundary"
    );
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 96, ..ProptestConfig::default() })]

    /// Paging is a faithful partition of the total order.
    #[test]
    fn cursor_paging_reproduces_the_total_order(
        values in prop::collection::vec(any_value(), 1..30),
        page_size in 1usize..8,
        desc in any::<bool>(),
    ) {
        let store = fresh();

        let upserts: Vec<UpsertIn> = values
            .iter()
            .enumerate()
            .map(|(i, v)| UpsertIn {
                table: "vals".into(),
                id: format!("r{i}"),
                data: r#"{"v":0}"#.into(),
                cols: vec![("v".into(), v.clone())],
                creation_time: store.clock_read().expect("clock advances"),
            })
            .collect();
        store
            .commit(
                WriteBatch {
                crdt_ops: Vec::new(),
                crdt_restores: vec![],
                    upserts,
                    deletes: vec![],
                    fresh_ids: vec![],
                    data_only_ids: vec![],
                    id_mappings: vec![],
                    schedules: vec![],
                },
                &CommitOptions::remote(),
            )
            .expect("seed commit");

        let order = if desc { Order::Desc } else { Order::Asc };
        let spec = ReadSpec {
            table: "vals".into(),
            index: Some("by_v".into()),
            bounds: None,
            order,
            page_size: None,
            cursor: None,
            resume_after_key: None,
        };

        let unpaged = doc_ids(
            &store
                .doc_page_read(&ReadSpec { page_size: Some(values.len() + 5), ..spec.clone() })
                .expect("unpaged read"),
        );
        let paged = paged_ids(&store, &spec, page_size);

        prop_assert_eq!(
            &paged,
            &unpaged,
            "page_size={} order={:?} reproduced a different sequence",
            page_size,
            order,
        );
    }

    /// An exact count agrees with the number of rows a read returns — for the whole table and for an
    /// `Eq` filter on any value (exercises `compile_count` against `compile_page_read`).
    #[test]
    fn exact_count_matches_the_rows_read(
        values in prop::collection::vec(any_value(), 0..30),
        eq_pick in any::<prop::sample::Index>(),
    ) {
        let store = fresh();
        let rows: Vec<UpsertIn> = values
            .iter()
            .enumerate()
            .map(|(i, v)| UpsertIn {
                table: "vals".into(),
                id: format!("r{i}"),
                data: r#"{"v":0}"#.into(),
                cols: vec![("v".into(), v.clone())],
                creation_time: store.clock_read().expect("clock"),
            })
            .collect();
        store
            .commit(
                WriteBatch {
                crdt_ops: Vec::new(),
                crdt_restores: vec![],
                    upserts: rows,
                    deletes: vec![],
                    fresh_ids: vec![],
                    data_only_ids: vec![],
                    id_mappings: vec![],
                    schedules: vec![],
                },
                &CommitOptions::remote(),
            )
            .expect("seed commit");

        let read_spec = |bounds: Option<Vec<Bound>>| ReadSpec {
            table: "vals".into(),
            index: Some("by_v".into()),
            bounds,
            order: Order::Asc,
            page_size: None,
            cursor: None,
            resume_after_key: None,
        };

        let total = store
            .doc_count_read(&CountSpec { table: "vals".into(), index: Some("by_v".into()), bounds: None })
            .expect("count");
        prop_assert_eq!(total, Some(values.len() as i64));
        prop_assert_eq!(total, Some(paged_ids(&store, &read_spec(None), 3).len() as i64));

        if !values.is_empty() {
            let needle = values[eq_pick.index(values.len())].clone();
            let bounds = Some(vec![Bound::Eq { value: needle }]);
            let counted = store
                .doc_count_read(&CountSpec {
                    table: "vals".into(),
                    index: Some("by_v".into()),
                    bounds: bounds.clone(),
                })
                .expect("eq count");
            if let Some(counted) = counted {
                let read = paged_ids(&store, &read_spec(bounds), 3).len() as i64;
                prop_assert_eq!(counted, read, "Eq count disagrees with rows read");
            }
        }
    }
}
