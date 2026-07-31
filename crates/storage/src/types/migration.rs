use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt::Write;

/// Permanent numeric identities for originated semantic records.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i64)]
pub enum OriginKind {
    Identity = 1,
    DeviceDocument = 2,
    LocalField = 3,
    Mutation = 4,
    PushEnvelope = 5,
    SettlementReceipt = 6,
    Schedule = 7,
    Upload = 8,
    Blob = 9,
    Revision = 10,
    CrdtEffect = 11,
    IdMapping = 12,
}

impl TryFrom<i64> for OriginKind {
    type Error = i64;

    fn try_from(value: i64) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Identity),
            2 => Ok(Self::DeviceDocument),
            3 => Ok(Self::LocalField),
            4 => Ok(Self::Mutation),
            5 => Ok(Self::PushEnvelope),
            6 => Ok(Self::SettlementReceipt),
            7 => Ok(Self::Schedule),
            8 => Ok(Self::Upload),
            9 => Ok(Self::Blob),
            10 => Ok(Self::Revision),
            11 => Ok(Self::CrdtEffect),
            12 => Ok(Self::IdMapping),
            _ => Err(value),
        }
    }
}

pub const ORIGIN_FLAG_QUARANTINED: i64 = 1;
pub const ORIGIN_FLAG_DISCARDED: i64 = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginRecord {
    pub identity_key: String,
    pub kind: i64,
    pub record_key: Vec<u8>,
    pub codec: i64,
    pub flags: i64,
    pub payload: Vec<u8>,
    pub payload_hash: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct OriginCursor {
    pub identity_key: String,
    pub kind: i64,
    pub record_key: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OriginPage {
    pub records: Vec<OriginRecord>,
    pub cursor: Option<OriginCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationDefinition {
    pub id: String,
    pub definition_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreContract {
    pub bootstrap_version: i64,
    #[serde(default)]
    pub package_epoch: i64,
    pub app_schema_hash: String,
    pub core_layout_hash: String,
    pub codec_set_hash: String,
    pub migrations: Vec<MigrationDefinition>,
}

impl StoreContract {
    #[must_use]
    pub fn for_schema(schema: &super::StoreSchema) -> Self {
        Self {
            bootstrap_version: 1,
            package_epoch: crate::sql::EMBEDDED_EPOCH,
            app_schema_hash: schema.hash.clone(),
            core_layout_hash: manifest_hash(&crate::sql::core_layout_manifest()),
            codec_set_hash: manifest_hash(&codec_manifest()),
            migrations: schema.migrations.clone(),
        }
    }

    pub fn hash(&self) -> Result<String, serde_json::Error> {
        serde_json::to_vec(self).map(|bytes| sha256_hex(&bytes))
    }

    #[must_use]
    pub fn has_migration_prefix(&self, previous: &Self) -> bool {
        self.migrations.starts_with(&previous.migrations)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationCandidate {
    pub active_generation: i64,
    pub candidate_generation: i64,
    pub source_contract_hash: String,
    pub target_contract_hash: String,
    pub retired_generations: Vec<i64>,
    pub applied_migrations: usize,
    pub required: bool,
    pub resumed: bool,
    pub progress_migration_id: Option<String>,
    pub progress_cursor: Option<OriginCursor>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationRecordTarget {
    pub identity_key: String,
    pub kind: i64,
    pub record_key: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationDisposition {
    pub target: MigrationRecordTarget,
    pub reason: String,
    pub discard: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationProgress {
    pub cursor: Option<OriginCursor>,
    pub upper_bound: Option<OriginCursor>,
    pub(crate) snapshot_cursor: Option<OriginCursor>,
    pub(crate) snapshot_complete: bool,
}

fn codec_manifest() -> Vec<(i64, i64, &'static str)> {
    vec![
        (OriginKind::Identity as i64, 1, "identity-json"),
        (OriginKind::DeviceDocument as i64, 1, "device-document-json"),
        (OriginKind::LocalField as i64, 1, "local-field-json"),
        (OriginKind::Mutation as i64, 1, "mutation-json"),
        (OriginKind::PushEnvelope as i64, 1, "push-envelope-json"),
        (
            OriginKind::SettlementReceipt as i64,
            1,
            "settlement-receipt-json",
        ),
        (OriginKind::Schedule as i64, 1, "schedule-json"),
        (OriginKind::Upload as i64, 1, "upload-json"),
        (OriginKind::Blob as i64, 1, "blob-json+payload-sha256"),
        (
            OriginKind::Revision as i64,
            1,
            "revision-json+payload-sha256",
        ),
        (OriginKind::CrdtEffect as i64, 1, "crdt-effect-json"),
        (OriginKind::IdMapping as i64, 1, "id-mapping-json"),
    ]
}

fn manifest_hash<T: Serialize>(value: &T) -> String {
    let bytes = serde_json::to_vec(value).expect("static manifest is serializable");
    sha256_hex(&bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            write!(output, "{byte:02x}").expect("writing to a string cannot fail");
            output
        })
}
