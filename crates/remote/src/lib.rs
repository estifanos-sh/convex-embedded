//! Native Convex remote protocol driver for the local-first storage engine.
//!
//! This crate owns networking and Convex protocol progress for native runtimes. The durable
//! local engine remains [`storage`]; this crate depends on it, and storage stays network-free.

#[cfg(not(target_arch = "wasm32"))]
pub mod client;
mod codec;
pub mod config;
pub mod driver;
pub mod error;
pub mod protocol;
/// `pull` and `push` stay private implementation modules.
mod pull;
mod push;
pub mod store;
pub mod tick;
pub mod transport;
pub mod upload;

use std::collections::BTreeMap;

#[cfg(not(target_arch = "wasm32"))]
pub use client::RemoteClient;
pub use config::RemoteFunction;
pub use config::{ClientId, DeploymentUrl, RemoteAuth, RemoteConfig, RemoteTiming};
pub use driver::{RemoteCursor, RemoteDriver, RemoteScope, RemoteSubscription};
pub use error::RemoteError;
#[cfg(not(target_arch = "wasm32"))]
pub use store::SystemRemoteClock;
pub use store::{RemoteClock, RemoteStore, RemoteStoreFuture};
pub use tick::{RemotePending, RemoteTick};
pub use transport::{
    ConnectRequest, RemoteTransport, SendRemoteTransport, ServerMessage, TransportEvent,
};

pub type ConvexArgs = BTreeMap<String, convex::Value>;
pub type RemoteResult<T> = Result<T, RemoteError>;
