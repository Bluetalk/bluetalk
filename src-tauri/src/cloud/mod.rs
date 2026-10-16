//! Cloud-Nachrichten: Relay-Verbindung, Live-Tunnel und Offline-Postfach.

mod config;
mod connection;
mod mailbox;
mod status;
mod tunnel;

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot, watch};
use uuid::Uuid;

use crate::{
    database::Database,
    error::{AppError, Result},
    peer_service::PeerService,
};

use config::{CloudConfig, from_command_value};
use mailbox::MailQueue;
use status::{CloudState, StatusSnapshot};

enum WsOut {
    Json(Value),
    Binary { tunnel_id: u32, payload: Vec<u8> },
    Pong(Vec<u8>),
}

enum ConnCmd {
    Reconfigure,
    Takeover,
    RefreshWatch,
    Open {
        peer_id: String,
        device: Option<String>,
        reply: oneshot::Sender<Result<Value>>,
    },
    DropPeerTunnels {
        peer_id: String,
    },
    Post {
        id: String,
        to: String,
        body: Value,
        reply: oneshot::Sender<Result<Value>>,
    },
    Ack {
        ids: Vec<String>,
    },
    Shutdown,
}

struct CloudShared {
    config: CloudConfig,
    snapshot: StatusSnapshot,
    mail: MailQueue,
    max_mail_body: usize,
    device_id: String,
    device_name: String,
}

pub struct CloudService {
    database: Arc<Database>,
    shared: Arc<Mutex<CloudShared>>,
    cmd_tx: mpsc::Sender<ConnCmd>,
    shutdown: watch::Sender<bool>,
}

impl CloudService {
    pub fn initialize(
        app: AppHandle,
        database: Arc<Database>,
        peers: Arc<PeerService>,
    ) -> Arc<Self> {
        let config = CloudConfig::load(&database);
        let device_id = config::load_or_create_device_id(&database);
        let device_name = config::local_device_name();
        let mut snapshot = StatusSnapshot::from_config(&config);
        snapshot.device_id = device_id.clone();
        snapshot.device_name = device_name.clone();
        let shared = Arc::new(Mutex::new(CloudShared {
            config,
            snapshot,
            mail: MailQueue::default(),
            max_mail_body: config::MAX_MAIL_BODY_BYTES,
            device_id,
            device_name,
        }));
        let (cmd_tx, cmd_rx) = mpsc::channel(64);
        let (shutdown_tx, shutdown_rx) = watch::channel(false);
        let service = Arc::new(Self {
            database,
            shared: shared.clone(),
            cmd_tx,
            shutdown: shutdown_tx,
        });
        tauri::async_runtime::spawn(connection::run(
            app,
            peers,
            shared,
            cmd_rx,
            shutdown_rx,
        ));
        service
    }

    pub fn is_online(&self) -> bool {
        self.shared.lock().snapshot.state == CloudState::Online
    }

    pub fn status(&self) -> Value {
        self.shared.lock().snapshot.to_value()
    }

    pub fn set_config(&self, value: &Value) -> Result<Value> {
        let config = from_command_value(value)?;
        config.save(&self.database)?;
        {
            let mut guard = self.shared.lock();
            guard.config = config.clone();
            guard.snapshot.enabled = config.enabled;
            guard.snapshot.relay_url = config.relay_url.clone();
        }
        self.reconnect();
        Ok(self.status())
    }

    pub fn reconnect(&self) {
        let _ = self.cmd_tx.try_send(ConnCmd::Reconfigure);
    }

    pub fn takeover(&self) -> Value {
        let _ = self.cmd_tx.try_send(ConnCmd::Takeover);
        self.status()
    }

    pub fn drop_relay_tunnels(&self, peer_id: &str) {
        if peer_id.trim().is_empty() {
            return;
        }
        let _ = self.cmd_tx.try_send(ConnCmd::DropPeerTunnels {
            peer_id: peer_id.to_owned(),
        });
    }

    pub fn refresh_watch(&self) {
        let _ = self.cmd_tx.try_send(ConnCmd::RefreshWatch);
    }

    pub async fn open_peer(&self, peer_id: &str) -> Result<Value> {
        if peer_id.trim().is_empty() {
            return Err(AppError::InvalidInput("peerId fehlt".to_owned()));
        }
        if !self.is_online() {
            return Err(AppError::Network("Cloud ist nicht online.".to_owned()));
        }
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(ConnCmd::Open {
                peer_id: peer_id.to_owned(),
                device: None,
                reply: reply_tx,
            })
            .await
            .map_err(|_| AppError::Network("Cloud-Dienst ist beendet.".to_owned()))?;
        match tokio::time::timeout(std::time::Duration::from_secs(20), reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AppError::Network("Cloud-Tunnel abgebrochen.".to_owned())),
            Err(_) => Err(AppError::Network(
                "Cloud-Tunnel zeitüberschritten.".to_owned(),
            )),
        }
    }

    pub async fn post_mail(&self, peer_id: &str, body: Value, id: Option<String>) -> Result<Value> {
        if peer_id.trim().is_empty() {
            return Err(AppError::InvalidInput("peerId fehlt".to_owned()));
        }
        if !self.is_online() {
            return Err(AppError::Network("Cloud ist nicht online.".to_owned()));
        }
        let id = mail_post_id(id);
        let (reply_tx, reply_rx) = oneshot::channel();
        self.cmd_tx
            .send(ConnCmd::Post {
                id,
                to: peer_id.to_owned(),
                body,
                reply: reply_tx,
            })
            .await
            .map_err(|_| AppError::Network("Cloud-Dienst ist beendet.".to_owned()))?;
        match tokio::time::timeout(std::time::Duration::from_secs(15), reply_rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(AppError::Network("Postfach-Anfrage abgebrochen.".to_owned())),
            Err(_) => Err(AppError::Network(
                "Postfach zeitüberschritten.".to_owned(),
            )),
        }
    }

    pub fn drain_mail(&self) -> Value {
        let items = self.shared.lock().mail.drain();
        Value::Array(
            items
                .into_iter()
                .map(|item| {
                    json!({
                        "id": item.id,
                        "from": item.from,
                        "ts": item.ts,
                        "body": item.body,
                    })
                })
                .collect(),
        )
    }

    pub fn ack_mail(&self, ids: Vec<String>) {
        let ids: Vec<String> = ids
            .into_iter()
            .map(|id| id.trim().to_owned())
            .filter(|id| !id.is_empty() && id.len() <= 128)
            .take(500)
            .collect();
        if ids.is_empty() {
            return;
        }
        self.shared.lock().mail.ack(&ids);
        let _ = self.cmd_tx.try_send(ConnCmd::Ack { ids });
    }

    pub async fn shutdown(&self) {
        let _ = self.shutdown.send(true);
        let _ = self.cmd_tx.send(ConnCmd::Shutdown).await;
    }
}

fn mail_post_id(id: Option<String>) -> String {
    match id {
        Some(raw) => {
            let trimmed = raw.trim();
            if !trimmed.is_empty()
                && trimmed.len() <= 128
                && trimmed
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
            {
                trimmed.to_owned()
            } else {
                Uuid::new_v4().to_string()
            }
        }
        None => Uuid::new_v4().to_string(),
    }
}
