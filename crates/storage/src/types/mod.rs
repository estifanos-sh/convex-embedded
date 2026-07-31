//! Data shapes mirroring the TS `storage/types.ts`. Field names, affinities, and bound encodings
//! must stay byte-parity with the TypeScript source of truth.

mod doc;
mod migration;
mod mutation;
mod remote;
mod rev;
mod schedule;
mod upload;

pub use doc::*;
pub use migration::*;
pub use mutation::*;
pub use remote::*;
pub use rev::*;
pub use schedule::*;
pub use upload::*;
