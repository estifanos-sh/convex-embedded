//! memory — native heap-residency harness behind the `testkit` feature. A net-tracking global
//! allocator records live bytes and peak per thread across four modeled scenarios (boot, steady
//! N=100, heavy pull of 10k rows, and the loro-residency verdict at 500 docs) plus the page-cache
//! bound the `cache_size` pragma enforces. Counters are thread-local, so scenarios stay isolated
//! under `cargo test`'s default parallelism (each test measures its own thread), matching the
//! `read.rs` allocator: `cargo test -p storage --features testkit --test memory -- --nocapture`.
#![cfg(feature = "testkit")]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use storage::testkit::*;
use storage::*;

thread_local! {
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

struct Tracking;

unsafe impl GlobalAlloc for Tracking {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        LIVE.with(|live| {
            let now = live.get().wrapping_add(layout.size());
            live.set(now);
            PEAK.with(|peak| peak.set(peak.get().max(now)));
        });
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.with(|live| live.set(live.get().wrapping_sub(layout.size())));
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static GLOBAL: Tracking = Tracking;

fn live_kb() -> usize {
    LIVE.with(Cell::get) / 1024
}

/// Net live growth and peak-above-start (KiB) on this thread while `f` runs, plus its result.
fn measure<R>(f: impl FnOnce() -> R) -> (usize, usize, R) {
    let start = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(start));
    let result = f();
    let end = LIVE.with(Cell::get);
    let peak = PEAK.with(Cell::get);
    (
        end.saturating_sub(start) / 1024,
        peak.saturating_sub(start) / 1024,
        result,
    )
}

fn record(scenario: &str, net_kb: usize, peak_kb: usize) {
    eprintln!("MEMBENCH scenario={scenario} netKB={net_kb} peakKB={peak_kb}");
}

fn crdt_schema() -> StoreSchema {
    StoreSchema {
        tables: vec![TableDef {
            name: "issues".into(),
            columns: vec![ColumnDef {
                name: "status".into(),
                field: None,
            }],
            crdt_fields: vec![CrdtFieldDef {
                field: "body".into(),
                kind: CrdtFieldKind::Text,
            }],
            indexes: vec![IndexDef {
                name: "by_status".into(),
                fields: vec!["status".into()],
                columns: None,
            }],
        }],
    }
}

fn seed_crdt_docs(store: &EmbeddedStore, count: usize) {
    let doc_writes = (0..count)
        .map(|i| DocWrite {
            table: "issues".into(),
            id: format!("doc{i:05}"),
            data: r#"{"body":"","title":"t"}"#.into(),
            cols: vec![("status".into(), ColValue::Text("open".into()))],
            creation_time: store.clock_read().unwrap(),
        })
        .collect();
    let crdt_ops = (0..count)
        .map(|i| CrdtOp {
            row: RowKey {
                table: "issues".into(),
                document_id: format!("doc{i:05}"),
            },
            field: "body".into(),
            operation: CrdtOperation::TextSplice {
                index: 0,
                delete: 0,
                insert: "the quick brown fox jumps over the lazy dog".into(),
            },
        })
        .collect();
    store
        .commit(
            WriteBatch {
                doc_writes,
                crdt_ops,
                ..WriteBatch::default()
            },
            &CommitOptions::default(),
        )
        .unwrap();
}

fn seed_plain_rows(store: &EmbeddedStore, count: usize) {
    let doc_writes = (0..count)
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
                doc_writes,
                ..WriteBatch::default()
            },
            &CommitOptions::remote(),
        )
        .unwrap();
}

fn full_scan(store: &EmbeddedStore) -> usize {
    let spec = ReadSpec {
        table: "vals".into(),
        index: Some("by_v".into()),
        order: Order::Asc,
        page_size: Some(1_024),
        ..Default::default()
    };
    let mut cursor: Option<String> = None;
    let mut seen = 0;
    loop {
        let page = store
            .doc_page_read(&ReadSpec {
                cursor: cursor.clone(),
                ..spec.clone()
            })
            .unwrap();
        seen += doc_ids(&page).len();
        match page.cursor {
            Some(next) => cursor = Some(next),
            None => return seen,
        }
    }
}

#[test]
fn scenario_boot_reopen_existing_store() {
    let path = tmp_path("mem_boot.db");
    let path_str = path.to_str().unwrap();
    {
        let store = EmbeddedStore::open(path_str).unwrap();
        store.setup(&crdt_schema()).unwrap();
        seed_crdt_docs(&store, 100);
        store.wal_write().unwrap();
    }
    let (net, peak, store) = measure(|| {
        let store = EmbeddedStore::open(path_str).unwrap();
        store.setup(&crdt_schema()).unwrap();
        store
    });
    record("boot_reopen_100docs", net, peak);
    assert!(
        net <= 20 * 1024,
        "boot of an existing 100-doc store retained {net} KiB (>20 MiB): page cache unbounded?"
    );
    drop(store);
}

#[test]
fn scenario_steady_state_100_docs() {
    let store = EmbeddedStore::open(tmp_path("mem_steady.db").to_str().unwrap()).unwrap();
    store.setup(&crdt_schema()).unwrap();
    let (net, peak, ()) = measure(|| {
        seed_crdt_docs(&store, 100);
        for i in 0..100 {
            let id = format!("doc{i:05}");
            store.crdt_snapshot_read("issues", &id).unwrap();
            read_doc(&store, "issues", &id);
        }
    });
    record("steady_state_100docs", net, peak);
    assert!(
        net <= 20 * 1024,
        "steady state with 100 materialized docs retained {net} KiB (>20 MiB)"
    );
}

#[test]
fn scenario_heavy_pull_10k_rows() {
    let store = EmbeddedStore::open(tmp_path("mem_pull.db").to_str().unwrap()).unwrap();
    store.setup(&vals_schema()).unwrap();
    let (net, peak, ()) = measure(|| {
        seed_plain_rows(&store, 10_000);
        full_scan(&store);
    });
    record("heavy_pull_10k_rows", net, peak);
    assert!(
        peak <= 64 * 1024,
        "heavy pull of 10k rows peaked at {peak} KiB (>64 MiB): the 16 MiB cache bound is not holding"
    );
}

/// The loro-residency verdict. `EmbeddedStore` holds no resident `LoroDoc`: every CRDT field is
/// materialized transiently per read and dropped (`crdt::field` constructs `LoroDoc::new()` then
/// imports on each call). So the live heap of a store must not scale with the number of docs kept
/// "open" — there is no open. A 500-doc store's retained heap stays within a small constant of a
/// 100-doc store (both dominated by the bounded page cache, not per-doc CRDT state), and reading one
/// doc 500 times is flat.
#[test]
fn scenario_loro_residency_flat_across_doc_count() {
    let small = EmbeddedStore::open(tmp_path("mem_resident_100.db").to_str().unwrap()).unwrap();
    small.setup(&crdt_schema()).unwrap();
    let (small_net, _, ()) = measure(|| {
        seed_crdt_docs(&small, 100);
        for i in 0..100 {
            small
                .crdt_snapshot_read("issues", &format!("doc{i:05}"))
                .unwrap();
        }
    });
    record("residency_100docs", small_net, 0);

    let large = EmbeddedStore::open(tmp_path("mem_resident_500.db").to_str().unwrap()).unwrap();
    large.setup(&crdt_schema()).unwrap();
    let (large_net, _, ()) = measure(|| {
        seed_crdt_docs(&large, 500);
        for i in 0..500 {
            large
                .crdt_snapshot_read("issues", &format!("doc{i:05}"))
                .unwrap();
        }
    });
    record("residency_500docs", large_net, 0);

    let base = live_kb();
    let (reread_net, _, ()) = measure(|| {
        for _ in 0..500 {
            large.crdt_snapshot_read("issues", "doc00000").unwrap();
        }
    });
    record(
        "residency_reread_one_500x",
        reread_net,
        base.saturating_sub(base),
    );

    assert!(
        reread_net <= 512,
        "re-reading one doc 500 times grew live heap {reread_net} KiB: a per-doc CRDT cache is \
         accumulating"
    );
    assert!(
        large_net <= small_net.saturating_mul(3) + 4 * 1024,
        "500-doc store retained {large_net} KiB vs {small_net} KiB for 100 docs: residency scales \
         with doc count, so LoroDocs are being held resident"
    );
}

/// The tuning is native-verifiable only by readback: turso backs page buffers with an `mmap` arena on
/// native (`buffer_pool::arena`, `MAP_PRIVATE | MAP_ANONYMOUS`), invisible to the Rust global
/// allocator, but with `std::alloc::alloc_zeroed` on wasm, where it lives in linear memory. So the
/// bound is applied here (readback `== -16384`) and its Rust-heap scan peak is insensitive to
/// `cache_size` on native — the cache's heap effect is a wasm `memory.buffer` fact the browser probe
/// records, not this harness.
#[test]
fn cache_size_pragma_is_applied_and_is_off_rust_heap_on_native() {
    let store = EmbeddedStore::open(tmp_path("mem_cache.db").to_str().unwrap()).unwrap();
    store.setup(&vals_schema()).unwrap();
    seed_plain_rows(&store, 10_000);

    assert_eq!(
        store.pragma_read("PRAGMA cache_size").unwrap(),
        Some(-16_384),
        "the tuned cache_size bound is not applied to the connection"
    );

    let wide = EmbeddedStore::open(tmp_path("mem_cache_wide.db").to_str().unwrap()).unwrap();
    wide.setup(&vals_schema()).unwrap();
    seed_plain_rows(&wide, 10_000);
    wide.pragma_read("PRAGMA cache_size = 100000").unwrap();
    let (_, wide_peak, _) = measure(|| full_scan(&wide));
    record("scan_cache_100000pages", 0, wide_peak);

    let (_, tuned_peak, _) = measure(|| full_scan(&store));
    record("scan_cache_16MiB", 0, tuned_peak);

    assert!(
        tuned_peak.abs_diff(wide_peak) <= 256,
        "native Rust-heap scan peak moved {} KiB between a 400 MiB and a 16 MiB cache ({tuned_peak} \
         vs {wide_peak}): the page cache is unexpectedly on the Rust heap on native",
        tuned_peak.abs_diff(wide_peak)
    );
}
