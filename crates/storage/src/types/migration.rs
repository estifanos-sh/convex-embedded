use crate::error::StorageError;
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
    /// Temporary, candidate-only queue-policy indexes. These are deleted before materialization
    /// and never become part of an active generation.
    CandidatePolicy = 13,
    /// Exact clean server projection metadata and row content. This is independent from the
    /// optimistic document/revision state and is restored before ownership edges and cursors.
    RemoteProjection = 14,
    /// One durable subscription-to-row ownership edge.
    RemoteMembership = 15,
    /// One retained authored-result cache entry.
    RemoteResult = 16,
    /// Pull progress for one subscription. Materialization validates that all referenced state was
    /// restored before publishing this cursor.
    RemoteCursor = 17,
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
            13 => Ok(Self::CandidatePolicy),
            14 => Ok(Self::RemoteProjection),
            15 => Ok(Self::RemoteMembership),
            16 => Ok(Self::RemoteResult),
            17 => Ok(Self::RemoteCursor),
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
pub struct StoreContract {
    pub bootstrap_version: i64,
    pub package_epoch: i64,
    pub app_schema_hash: String,
    pub kernel_layout_hash: String,
    pub generation_layout_hash: String,
    pub origin_writer_hash: String,
    pub origin_reader_hash: String,
    /// Identity of the candidate setup graph.
    #[serde(default)]
    pub setup_hash: String,
}

impl StoreContract {
    #[must_use]
    pub fn for_schema(schema: &super::StoreSchema) -> Self {
        Self {
            bootstrap_version: crate::sql::BOOTSTRAP_VERSION,
            package_epoch: crate::sql::EMBEDDED_EPOCH,
            app_schema_hash: schema.hash.clone(),
            kernel_layout_hash: manifest_hash(&crate::sql::kernel_layout_manifest()),
            generation_layout_hash: manifest_hash(&crate::sql::generation_contract_manifest()),
            origin_writer_hash: manifest_hash(&origin_writer_manifest()),
            origin_reader_hash: manifest_hash(&origin_reader_manifest()),
            setup_hash: schema.setup_hash.clone(),
        }
    }

    pub fn hash(&self) -> Result<String, serde_json::Error> {
        serde_json::to_vec(self).map(|bytes| sha256_hex(&bytes))
    }

    /// Reader coverage is a runtime capability, not a reason to rewrite a store. Everything else
    /// is persisted candidate identity.
    #[must_use]
    pub(crate) fn has_same_candidate_identity(&self, other: &Self) -> bool {
        self.bootstrap_version == other.bootstrap_version
            && self.package_epoch == other.package_epoch
            && self.app_schema_hash == other.app_schema_hash
            && self.kernel_layout_hash == other.kernel_layout_hash
            && self.generation_layout_hash == other.generation_layout_hash
            && self.origin_writer_hash == other.origin_writer_hash
            && self.setup_hash == other.setup_hash
    }
}

#[derive(Debug, Clone)]
pub struct MigrationCandidate {
    pub active_generation: i64,
    pub source_schema: super::StoreSchema,
    pub candidate_generation: i64,
    /// A stale unpublished generation must be retired before preparation can be retried.
    pub cleanup_generation: Option<i64>,
    pub setup_complete: bool,
    pub source_contract_hash: String,
    pub target_contract_hash: String,
    pub retired_generations: Vec<i64>,
    pub required: bool,
    pub resumed: bool,
}

/// Result of one crash-durable, bounded candidate lifecycle transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationStep {
    /// True only after the phase's durable completion marker has committed.
    pub done: bool,
    /// Semantic records processed by this transaction. Zero is valid for phase transitions.
    pub records: usize,
}

#[derive(Clone, Copy)]
struct OriginCodec {
    kind: OriginKind,
    codec: i64,
    name: &'static str,
    current: bool,
    decode: fn(&[u8]) -> Result<serde_json::Value, StorageError>,
    encode: fn(&serde_json::Value) -> Result<Vec<u8>, StorageError>,
}

fn json_v1_decode(payload: &[u8]) -> Result<serde_json::Value, StorageError> {
    serde_json::from_slice(payload).map_err(|error| StorageError::Decode {
        expected: "originated record JSON",
        index: 0,
        got: error.to_string(),
    })
}

fn json_v1_encode(value: &serde_json::Value) -> Result<Vec<u8>, StorageError> {
    serde_json::to_vec(value).map_err(|error| StorageError::Unsatisfiable(error.to_string()))
}

macro_rules! json_codec {
    ($kind:ident, $name:literal) => {
        OriginCodec {
            kind: OriginKind::$kind,
            codec: 1,
            name: $name,
            current: true,
            decode: json_v1_decode,
            encode: json_v1_encode,
        }
    };
}

const ORIGIN_CODECS: [OriginCodec; 17] = [
    json_codec!(Identity, "identity-json"),
    json_codec!(DeviceDocument, "device-document-json"),
    json_codec!(LocalField, "local-field-json"),
    json_codec!(Mutation, "mutation-json"),
    json_codec!(PushEnvelope, "push-envelope-json"),
    json_codec!(SettlementReceipt, "settlement-receipt-json"),
    json_codec!(Schedule, "schedule-json"),
    json_codec!(Upload, "upload-json"),
    json_codec!(Blob, "blob-json+payload-sha256"),
    json_codec!(Revision, "revision-json+payload-sha256"),
    json_codec!(CrdtEffect, "crdt-effect-json"),
    json_codec!(IdMapping, "id-mapping-json"),
    json_codec!(CandidatePolicy, "candidate-policy-json"),
    json_codec!(RemoteProjection, "remote-projection-json"),
    json_codec!(RemoteMembership, "remote-membership-json"),
    json_codec!(RemoteResult, "remote-result-json"),
    json_codec!(RemoteCursor, "remote-cursor-json"),
];

/// Testkit-only retained readers exercise real dispatch and disposition behavior without claiming
/// a released production codec. They are deliberately excluded from both contract manifests.
#[cfg(any(test, feature = "testkit"))]
const TEST_ORIGIN_CODECS: [OriginCodec; 2] = [
    OriginCodec {
        kind: OriginKind::Blob,
        codec: 2,
        name: "blob-json+payload-sha256-testkit-reader",
        current: false,
        decode: json_v1_decode,
        encode: json_v1_encode,
    },
    OriginCodec {
        kind: OriginKind::Revision,
        codec: 2,
        name: "revision-json+payload-sha256-testkit-reader",
        current: false,
        decode: json_v1_decode,
        encode: json_v1_encode,
    },
];

fn origin_codec_read(kind: OriginKind, codec: i64) -> Option<&'static OriginCodec> {
    let production = ORIGIN_CODECS
        .iter()
        .find(|entry| entry.kind == kind && entry.codec == codec);
    #[cfg(any(test, feature = "testkit"))]
    {
        production.or_else(|| {
            TEST_ORIGIN_CODECS
                .iter()
                .find(|entry| entry.kind == kind && entry.codec == codec)
        })
    }
    #[cfg(not(any(test, feature = "testkit")))]
    {
        production
    }
}

fn origin_writer_manifest() -> Vec<(i64, i64, &'static str, &'static str)> {
    ORIGIN_CODECS
        .iter()
        .filter(|entry| entry.current)
        .map(|entry| (entry.kind as i64, entry.codec, entry.name, "current-writer"))
        .collect()
}

fn origin_reader_manifest() -> Vec<(i64, i64, &'static str)> {
    ORIGIN_CODECS
        .iter()
        .map(|entry| (entry.kind as i64, entry.codec, entry.name))
        .collect()
}

pub(crate) fn origin_current_codec(kind: OriginKind) -> i64 {
    ORIGIN_CODECS
        .iter()
        .find(|entry| entry.kind == kind && entry.current)
        .expect("every permanent origin kind has exactly one current writer")
        .codec
}

pub(crate) fn origin_decode(
    kind: i64,
    codec: i64,
    payload: &[u8],
) -> Result<(OriginKind, serde_json::Value), StorageError> {
    let kind = OriginKind::try_from(kind).map_err(|unknown| {
        StorageError::IncompatibleStore(format!("unknown originated record kind {unknown}"))
    })?;
    let entry = origin_codec_read(kind, codec).ok_or_else(|| {
        StorageError::IncompatibleStore(format!(
            "unsupported originated codec {codec} for kind {}",
            kind as i64
        ))
    })?;
    let value = (entry.decode)(payload)?;
    Ok((kind, value))
}

pub(crate) fn origin_encode_current(
    kind: OriginKind,
    value: &serde_json::Value,
) -> Result<(i64, Vec<u8>), StorageError> {
    let entry = ORIGIN_CODECS
        .iter()
        .find(|entry| entry.kind == kind && entry.current)
        .expect("every permanent origin kind has exactly one current writer");
    Ok((entry.codec, (entry.encode)(value)?))
}

type OriginAdapterFn = fn(OriginKind, serde_json::Value) -> Result<serde_json::Value, StorageError>;

struct OriginAdapter {
    introduced_epoch: i64,
    adapt: OriginAdapterFn,
}

// Epoch 47 is the baseline, so it has no predecessor adapter. Future adapters are appended here
// and retained while a released source epoch can still reach the current package.
const ORIGIN_ADAPTERS: [OriginAdapter; 0] = [];

pub(crate) fn origin_adapt(
    kind: OriginKind,
    mut value: serde_json::Value,
    source_epoch: i64,
    target_epoch: i64,
) -> Result<serde_json::Value, StorageError> {
    for adapter in ORIGIN_ADAPTERS
        .iter()
        .filter(|adapter| adapter_applies(source_epoch, adapter.introduced_epoch, target_epoch))
    {
        value = (adapter.adapt)(kind, value)?;
    }
    Ok(value)
}

const fn adapter_applies(source_epoch: i64, introduced_epoch: i64, target_epoch: i64) -> bool {
    source_epoch < introduced_epoch && introduced_epoch <= target_epoch
}

#[cfg(any(test, feature = "testkit"))]
#[must_use]
pub fn origin_codec_manifest_debug() -> (String, String) {
    (
        manifest_hash(&origin_writer_manifest()),
        manifest_hash(&origin_reader_manifest()),
    )
}

#[cfg(any(test, feature = "testkit"))]
#[must_use]
pub const fn origin_adapter_applies_debug(
    source_epoch: i64,
    introduced_epoch: i64,
    target_epoch: i64,
) -> bool {
    adapter_applies(source_epoch, introduced_epoch, target_epoch)
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
