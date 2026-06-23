use crate::value::Value;

/// Upon a protocol failure, an explanation of the failure to pass in on reconnect.
pub type ReconnectProtocolReason = String;

/// A Convex server message decoded with this crate's Convex value type.
pub type ServerMessage = convex_sync_types::ServerMessage<Value>;
