use std::time::Duration;

use convex::Value as ProtocolValue;
use convex_sync_types::{ClientMessage, SessionId, Timestamp};
#[cfg(not(target_arch = "wasm32"))]
use futures_util::{
    future::{BoxFuture, FutureExt},
    stream::{SplitSink, SplitStream},
    SinkExt, StreamExt,
};
use std::future::Future;
#[cfg(not(target_arch = "wasm32"))]
use tokio::{net::TcpStream, sync::mpsc, task::JoinHandle, time};
#[cfg(not(target_arch = "wasm32"))]
use tokio_tungstenite::{
    connect_async,
    tungstenite::{client::IntoClientRequest, protocol::Message, Error as WebSocketError},
    MaybeTlsStream, WebSocketStream,
};
use url::Url;

#[cfg(not(target_arch = "wasm32"))]
use crate::RemoteError;
use crate::{config::ClientId, RemoteResult};

pub type ServerMessage = convex_sync_types::ServerMessage<ProtocolValue>;

#[derive(Debug, Clone)]
pub struct ConnectRequest {
    pub sync_url: Url,
    pub client_id: ClientId,
    pub session_id: SessionId,
    pub connection_count: u32,
    pub last_close_reason: String,
    pub max_observed_timestamp: Option<Timestamp>,
    pub client_ts: Option<u64>,
}

#[derive(Debug)]
pub enum TransportEvent {
    ServerMessage(ServerMessage),
    Timeout,
    Closed(String),
}

pub trait RemoteTransport {
    type Connect<'a>: Future<Output = RemoteResult<()>> + 'a
    where
        Self: 'a;
    type SendMessage<'a>: Future<Output = RemoteResult<()>> + 'a
    where
        Self: 'a;
    type Receive<'a>: Future<Output = RemoteResult<TransportEvent>> + 'a
    where
        Self: 'a;
    type Close<'a>: Future<Output = RemoteResult<()>> + 'a
    where
        Self: 'a;

    fn connect(&mut self, request: ConnectRequest) -> Self::Connect<'_>;
    fn send(&mut self, message: ClientMessage) -> Self::SendMessage<'_>;
    fn receive(&mut self, timeout: Duration) -> Self::Receive<'_>;
    /// Wait for the next transport event without driving a periodic foreground pull.
    ///
    /// Native actors override this with an unbounded websocket read. The default
    /// preserves the existing host contract for transports that only expose a
    /// bounded receive operation.
    fn receive_wait(&mut self) -> Self::Receive<'_> {
        self.receive(Duration::MAX)
    }
    fn close(&mut self) -> Self::Close<'_>;
}

pub trait SendRemoteTransport: RemoteTransport + Send + 'static
where
    for<'a> Self::Connect<'a>: Send,
    for<'a> Self::SendMessage<'a>: Send,
    for<'a> Self::Receive<'a>: Send,
    for<'a> Self::Close<'a>: Send,
{
}

impl<T> SendRemoteTransport for T
where
    T: RemoteTransport + Send + 'static,
    for<'a> T::Connect<'a>: Send,
    for<'a> T::SendMessage<'a>: Send,
    for<'a> T::Receive<'a>: Send,
    for<'a> T::Close<'a>: Send,
{
}

#[cfg(not(target_arch = "wasm32"))]
type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
#[cfg(not(target_arch = "wasm32"))]
type WsSink = SplitSink<WsStream, Message>;
#[cfg(not(target_arch = "wasm32"))]
type WsReader = SplitStream<WsStream>;

#[cfg(not(target_arch = "wasm32"))]
#[derive(Debug, Default)]
pub struct WebSocketTransport {
    events: Option<mpsc::Receiver<RemoteResult<TransportEvent>>>,
    reader: Option<JoinHandle<()>>,
    sink: Option<WsSink>,
}

#[cfg(not(target_arch = "wasm32"))]
impl WebSocketTransport {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn encode_message(message: ClientMessage) -> RemoteResult<Message> {
        let json = serde_json::Value::try_from(message)
            .map_err(|e| RemoteError::Protocol(e.to_string()))?;
        Ok(Message::Text(json.to_string().into()))
    }

    fn decode_message(
        message: Option<Result<Message, WebSocketError>>,
    ) -> RemoteResult<TransportEvent> {
        match message {
            Some(Ok(Message::Text(text))) => {
                let json: serde_json::Value = serde_json::from_str(&text)
                    .map_err(|e| RemoteError::Protocol(e.to_string()))?;
                json.try_into()
                    .map(TransportEvent::ServerMessage)
                    .map_err(|e: anyhow::Error| RemoteError::Protocol(e.to_string()))
            }
            Some(Ok(Message::Close(frame))) => {
                let reason =
                    frame.map_or_else(|| "websocket closed".to_owned(), |f| f.reason.to_string());
                Ok(TransportEvent::Closed(reason))
            }
            Some(Ok(
                Message::Ping(_) | Message::Pong(_) | Message::Binary(_) | Message::Frame(_),
            )) => Ok(TransportEvent::Timeout),
            Some(Err(e)) => Err(RemoteError::Transport(e.to_string())),
            None => Ok(TransportEvent::Closed("websocket ended".to_owned())),
        }
    }

    async fn read(mut reader: WsReader, events: mpsc::Sender<RemoteResult<TransportEvent>>) {
        loop {
            let event = Self::decode_message(reader.next().await);
            let terminal = matches!(&event, Err(_) | Ok(TransportEvent::Closed(_)));
            if events.send(event).await.is_err() || terminal {
                return;
            }
        }
    }

    async fn receive_event(
        events: &mut mpsc::Receiver<RemoteResult<TransportEvent>>,
    ) -> RemoteResult<TransportEvent> {
        events
            .recv()
            .await
            .unwrap_or_else(|| Ok(TransportEvent::Closed("websocket reader ended".to_owned())))
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl RemoteTransport for WebSocketTransport {
    type Connect<'a> = BoxFuture<'a, RemoteResult<()>>;
    type SendMessage<'a> = BoxFuture<'a, RemoteResult<()>>;
    type Receive<'a> = BoxFuture<'a, RemoteResult<TransportEvent>>;
    type Close<'a> = BoxFuture<'a, RemoteResult<()>>;

    fn connect(&mut self, request: ConnectRequest) -> Self::Connect<'_> {
        async move {
            let mut ws_request = (&request.sync_url)
                .into_client_request()
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            ws_request.headers_mut().insert(
                "Convex-Client",
                request
                    .client_id
                    .as_str()
                    .try_into()
                    .map_err(|e| RemoteError::InvalidConfig(format!("bad client id: {e}")))?,
            );
            let (mut stream, _) = connect_async(ws_request)
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            let connect = ClientMessage::Connect {
                session_id: request.session_id,
                connection_count: request.connection_count,
                last_close_reason: request.last_close_reason,
                max_observed_timestamp: request.max_observed_timestamp,
                client_ts: request.client_ts,
            };
            stream
                .send(Self::encode_message(connect)?)
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))?;
            if let Some(reader) = self.reader.take() {
                reader.abort();
            }
            let (sink, reader) = stream.split();
            let (event_tx, event_rx) = mpsc::channel(256);
            self.events = Some(event_rx);
            self.reader = Some(tokio::spawn(Self::read(reader, event_tx)));
            self.sink = Some(sink);
            Ok(())
        }
        .boxed()
    }

    fn send(&mut self, message: ClientMessage) -> Self::SendMessage<'_> {
        async move {
            let sink = self
                .sink
                .as_mut()
                .ok_or_else(|| RemoteError::Transport("websocket is not connected".to_owned()))?;
            sink.send(Self::encode_message(message)?)
                .await
                .map_err(|e| RemoteError::Transport(e.to_string()))
        }
        .boxed()
    }

    fn receive(&mut self, timeout: Duration) -> Self::Receive<'_> {
        async move {
            let events = self
                .events
                .as_mut()
                .ok_or_else(|| RemoteError::Transport("websocket is not connected".to_owned()))?;
            match time::timeout(timeout, Self::receive_event(events)).await {
                Ok(event) => event,
                Err(_) => Ok(TransportEvent::Timeout),
            }
        }
        .boxed()
    }

    fn receive_wait(&mut self) -> Self::Receive<'_> {
        async move {
            let events = self
                .events
                .as_mut()
                .ok_or_else(|| RemoteError::Transport("websocket is not connected".to_owned()))?;
            Self::receive_event(events).await
        }
        .boxed()
    }

    fn close(&mut self) -> Self::Close<'_> {
        async move {
            self.events.take();
            if let Some(mut sink) = self.sink.take() {
                sink.close()
                    .await
                    .map_err(|e| RemoteError::Transport(e.to_string()))?;
            }
            if let Some(reader) = self.reader.take() {
                reader.abort();
            }
            Ok(())
        }
        .boxed()
    }
}
