//! schedule — migrated from the former inline `src/tests.rs`, reaching private internals only
//! through `storage::testkit`. Run with `--features testkit`.
#![cfg(feature = "testkit")]
#![allow(
    clippy::too_many_lines,
    clippy::unreadable_literal,
    clippy::similar_names
)]

use storage::testkit::*;
use storage::*;

#[test]
fn a_scheduled_row_folded_into_a_commit_batch_is_visible_after_commit() {
    let store = EmbeddedStore::open(
        tmp_path("embedded_schedule_batch_commit.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    let batch = WriteBatch {
        schedules: vec![ScheduledJob {
            job_id: "job:batch".into(),
            kind: ScheduledFunctionKind::Mutation,
            name: "tasks:run".into(),
            args: "{}".into(),
            due_time: 100,
            state: ScheduledState::Pending,
            created_time: 80,
            updated_time: 80,
        }],
        ..WriteBatch::default()
    };
    store.commit(batch, &CommitOptions::default()).unwrap();

    let jobs = store.schedule_read().unwrap();
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0].job_id, "job:batch");
}

#[test]
fn a_commit_fault_leaves_no_scheduled_row() {
    let store = EmbeddedStore::open(
        tmp_path("embedded_schedule_commit_fault.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    let batch = WriteBatch {
        schedules: vec![ScheduledJob {
            job_id: "job:atomic".into(),
            kind: ScheduledFunctionKind::Mutation,
            name: "tasks:run".into(),
            args: "{}".into(),
            due_time: 100,
            state: ScheduledState::Pending,
            created_time: 80,
            updated_time: 80,
        }],
        ..WriteBatch::default()
    };
    fail_next_commit();
    assert!(store.commit(batch, &CommitOptions::default()).is_err());
    assert!(store.schedule_read().unwrap().is_empty());
}

#[test]
fn schedule_state_transitions_return_persisted_rows() {
    let store =
        EmbeddedStore::open(tmp_path("embedded_schedule_states.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .schedule_write(&ScheduledJob {
            job_id: "job:1".into(),
            kind: ScheduledFunctionKind::Mutation,
            name: "tasks:run".into(),
            args: "{}".into(),
            due_time: 100,
            state: ScheduledState::Pending,
            created_time: 80,
            updated_time: 80,
        })
        .unwrap();

    let running = store.schedule_lease_write(100).unwrap().unwrap();
    assert_eq!(
        running.state,
        ScheduledState::Running {
            lease_until: 100 + store::SCHEDULE_LEASE_MS,
        }
    );

    let complete = store.schedule_complete("job:1", 120).unwrap().unwrap();
    assert_eq!(complete.state, ScheduledState::Complete);
    assert_eq!(complete.updated_time, 120);

    assert!(store.schedule_fail("job:1", 130).unwrap().is_none());
}

#[test]
fn remote_schedule_completion_is_atomic_with_its_push_settlement() {
    let store = EmbeddedStore::open(
        tmp_path("embedded_schedule_remote_complete.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    for ordinal in 0..2 {
        store
            .schedule_write(&ScheduledJob {
                job_id: format!("job:{ordinal}"),
                kind: ScheduledFunctionKind::Mutation,
                name: "tasks:run".into(),
                args: "{}".into(),
                due_time: 100,
                state: ScheduledState::Pending,
                created_time: 80,
                updated_time: 80,
            })
            .unwrap();
    }
    let mappings = vec![
        RemoteScheduleMapping {
            local_id: "job:0".to_owned(),
            server_id: "hosted:0".to_owned(),
        },
        RemoteScheduleMapping {
            local_id: "job:1".to_owned(),
            server_id: "hosted:1".to_owned(),
        },
    ];
    store
        .remote_push_envelope_write("schedule-a", 1, "{}", 100)
        .unwrap();

    store
        .remote_settlement_write(&RemoteSettlementWrite {
            mutation_id: "schedule-a".to_owned(),
            expected_commit_seq: 1,
            now_ms: 120,
            outcome: RemoteSettlementOutcome::Applied {
                ids: Vec::new(),
                schedules: mappings.clone(),
                projections: Vec::new(),
                crdt: Vec::new(),
            },
        })
        .unwrap();
    assert!(store
        .schedule_read()
        .unwrap()
        .iter()
        .all(|job| job.state == ScheduledState::Complete));
    assert_eq!(
        store
            .id_read("_scheduled_functions", "job:0")
            .unwrap()
            .unwrap()
            .convex_id(),
        Some("hosted:0")
    );
    let canceled = store.schedule_cancel("job:0", 135).unwrap().unwrap();
    assert_eq!(canceled.state, ScheduledState::Canceled);
    store
        .remote_push_envelope_write("schedule-b", 2, "{}", 136)
        .unwrap();
    let mismatched = vec![RemoteScheduleMapping {
        local_id: "job:0".to_owned(),
        server_id: "hosted:changed".to_owned(),
    }];
    assert!(store
        .remote_settlement_write(&RemoteSettlementWrite {
            mutation_id: "schedule-b".to_owned(),
            expected_commit_seq: 2,
            now_ms: 140,
            outcome: RemoteSettlementOutcome::Applied {
                ids: Vec::new(),
                schedules: mismatched,
                projections: Vec::new(),
                crdt: Vec::new(),
            },
        })
        .is_err());
    assert_eq!(
        store
            .id_read("_scheduled_functions", "job:0")
            .unwrap()
            .unwrap()
            .convex_id(),
        Some("hosted:0")
    );
    assert_eq!(
        store.remote_push_envelope_read(10).unwrap(),
        vec!["{}".to_owned()]
    );
}

#[test]
fn schedule_cancel_returns_canceled_row() {
    let store =
        EmbeddedStore::open(tmp_path("embedded_schedule_cancel.db").to_str().unwrap()).unwrap();
    store.setup(&schema()).unwrap();
    store
        .schedule_write(&ScheduledJob {
            job_id: "job:1".into(),
            kind: ScheduledFunctionKind::Mutation,
            name: "tasks:run".into(),
            args: "{}".into(),
            due_time: 100,
            state: ScheduledState::Pending,
            created_time: 80,
            updated_time: 80,
        })
        .unwrap();

    let canceled = store.schedule_cancel("job:1", 110).unwrap().unwrap();
    assert_eq!(canceled.state, ScheduledState::Canceled);
    assert_eq!(canceled.updated_time, 110);
    assert_eq!(
        store.schedule_read().unwrap()[0].state,
        ScheduledState::Canceled
    );
}

#[test]
fn schedule_lease_write_reclaims_expired_running_job() {
    let store = EmbeddedStore::open(
        tmp_path("embedded_schedule_lease_recover.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    store
        .schedule_write(&ScheduledJob {
            job_id: "job:1".into(),
            kind: ScheduledFunctionKind::Mutation,
            name: "tasks:run".into(),
            args: "{}".into(),
            due_time: 100,
            state: ScheduledState::Pending,
            created_time: 80,
            updated_time: 80,
        })
        .unwrap();

    let claimed = store.schedule_lease_write(100).unwrap().unwrap();
    assert_eq!(
        claimed.state,
        ScheduledState::Running {
            lease_until: 100 + store::SCHEDULE_LEASE_MS,
        }
    );
    assert_eq!(claimed.job_id, "job:1");

    assert!(store
        .schedule_lease_write(100 + store::SCHEDULE_LEASE_MS - 1)
        .unwrap()
        .is_none());

    let reclaim_at = 100 + store::SCHEDULE_LEASE_MS + 1;
    let reclaimed = store.schedule_lease_write(reclaim_at).unwrap().unwrap();
    assert_eq!(reclaimed.job_id, "job:1");
    assert_eq!(
        reclaimed.state,
        ScheduledState::Running {
            lease_until: reclaim_at + store::SCHEDULE_LEASE_MS,
        }
    );
    assert_eq!(reclaimed.updated_time, reclaim_at);
}

#[test]
fn scheduled_state_rejects_impossible_lease_combinations() {
    assert_eq!(ScheduledState::decode("pending", Some(1)), None);
    assert_eq!(ScheduledState::decode("running", None), None);
    assert_eq!(ScheduledState::decode("complete", Some(1)), None);
    assert_eq!(ScheduledState::decode("unknown", None), None);
}

#[test]
fn schedule_lease_write_does_not_steal_running_job_under_valid_lease() {
    let store = EmbeddedStore::open(
        tmp_path("embedded_schedule_lease_guard.db")
            .to_str()
            .unwrap(),
    )
    .unwrap();
    store.setup(&schema()).unwrap();
    store
        .schedule_write(&ScheduledJob {
            job_id: "job:1".into(),
            kind: ScheduledFunctionKind::Mutation,
            name: "tasks:run".into(),
            args: "{}".into(),
            due_time: 100,
            state: ScheduledState::Pending,
            created_time: 80,
            updated_time: 80,
        })
        .unwrap();

    let claimed = store.schedule_lease_write(100).unwrap().unwrap();
    assert!(matches!(claimed.state, ScheduledState::Running { .. }));

    assert!(store.schedule_lease_write(100).unwrap().is_none());
    assert!(store
        .schedule_lease_write(100 + store::SCHEDULE_LEASE_MS - 1)
        .unwrap()
        .is_none());
}
