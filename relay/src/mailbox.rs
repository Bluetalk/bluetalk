//! SQLite-Postfach: Quoten, TTL, idempotente IDs, Blocking-Thread.

use std::path::Path;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::proto::MAX_MAIL_BODY;
use crate::util::unix_ms;

const MAIL_PER_RECIPIENT: i64 = 1000;
const MAIL_BYTES_PER_RECIPIENT: i64 = 128 * 1024 * 1024;
const MAIL_PER_PAIR: i64 = 300;
const MAIL_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone)]
pub struct MailRow {
    pub id: String,
    pub from: String,
    pub ts: i64,
    pub body: Value,
    pub pushed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PostOutcome {
    /// Neue Nachricht liegt im Postfach. `pushed` setzt der Aufrufer nach der
    /// ersten Live-Zustellung (an irgendein Gerät); `list` liefert sie trotzdem
    /// an jedes sich anmeldende Gerät, bis das erste `ack` löscht.
    Stored,
    Duplicate {
        status: &'static str,
    },
    Failed(&'static str),
}

enum Job {
    Post {
        from: String,
        id: String,
        to: String,
        body: String,
        size: i64,
        reply: oneshot::Sender<PostOutcome>,
    },
    List {
        recipient: String,
        reply: oneshot::Sender<Vec<MailRow>>,
    },
    Ack {
        recipient: String,
        ids: Vec<String>,
        reply: oneshot::Sender<()>,
    },
    MarkPushed {
        sender: String,
        id: String,
        reply: oneshot::Sender<()>,
    },
    Cleanup {
        reply: oneshot::Sender<()>,
    },
}

#[derive(Clone)]
pub struct Mailbox {
    tx: mpsc::Sender<Job>,
}

impl Mailbox {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = open_db(path)?;
        let (tx, mut rx) = mpsc::channel::<Job>(64);
        std::thread::Builder::new()
            .name("bluetalk-mailbox".into())
            .spawn(move || {
                let mut conn = conn;
                while let Some(job) = rx.blocking_recv() {
                    handle(&mut conn, job);
                }
            })
            .map_err(|e| format!("mailbox thread: {e}"))?;
        Ok(Self { tx })
    }

    pub async fn post(&self, from: &str, id: &str, to: &str, body: &Value) -> PostOutcome {
        let Ok(raw) = serde_json::to_vec(body) else {
            return PostOutcome::Failed("invalid");
        };
        if raw.len() > MAX_MAIL_BODY {
            return PostOutcome::Failed("too_large");
        }
        let (reply, rx) = oneshot::channel();
        let job = Job::Post {
            from: from.to_string(),
            id: id.to_string(),
            to: to.to_string(),
            body: String::from_utf8_lossy(&raw).into_owned(),
            size: raw.len() as i64,
            reply,
        };
        if self.tx.send(job).await.is_err() {
            return PostOutcome::Failed("invalid");
        }
        rx.await.unwrap_or(PostOutcome::Failed("invalid"))
    }

    pub async fn list(&self, recipient: &str) -> Vec<MailRow> {
        let (reply, rx) = oneshot::channel();
        if self
            .tx
            .send(Job::List {
                recipient: recipient.to_string(),
                reply,
            })
            .await
            .is_err()
        {
            return Vec::new();
        }
        rx.await.unwrap_or_default()
    }

    pub async fn ack(&self, recipient: &str, ids: Vec<String>) {
        let (reply, rx) = oneshot::channel();
        if self
            .tx
            .send(Job::Ack {
                recipient: recipient.to_string(),
                ids,
                reply,
            })
            .await
            .is_err()
        {
            return;
        }
        let _ = rx.await;
    }

    pub async fn mark_pushed(&self, sender: &str, id: &str) {
        let (reply, rx) = oneshot::channel();
        if self
            .tx
            .send(Job::MarkPushed {
                sender: sender.to_string(),
                id: id.to_string(),
                reply,
            })
            .await
            .is_err()
        {
            return;
        }
        let _ = rx.await;
    }

    pub async fn cleanup(&self) {
        let (reply, rx) = oneshot::channel();
        if self.tx.send(Job::Cleanup { reply }).await.is_err() {
            return;
        }
        let _ = rx.await;
    }
}

fn open_db(path: &Path) -> Result<Connection, String> {
    crate::db::open(path)
}

fn handle(conn: &mut Connection, job: Job) {
    match job {
        Job::Post {
            from,
            id,
            to,
            body,
            size,
            reply,
        } => {
            let _ = reply.send(post_sql(conn, &from, &id, &to, &body, size));
        }
        Job::List { recipient, reply } => {
            let _ = reply.send(list_sql(conn, &recipient));
        }
        Job::Ack {
            recipient,
            ids,
            reply,
        } => {
            ack_sql(conn, &recipient, &ids);
            let _ = reply.send(());
        }
        Job::MarkPushed { sender, id, reply } => {
            let _ = conn.execute(
                "UPDATE mail SET pushed = 1 WHERE sender = ?1 AND id = ?2",
                params![sender, id],
            );
            let _ = reply.send(());
        }
        Job::Cleanup { reply } => {
            let cutoff = unix_ms() - MAIL_TTL_MS;
            let _ = conn.execute("DELETE FROM mail WHERE ts < ?1", params![cutoff]);
            let _ = conn.execute("DELETE FROM mail_ids WHERE ts < ?1", params![cutoff]);
            let _ = reply.send(());
        }
    }
}

fn post_sql(
    conn: &Connection,
    from: &str,
    id: &str,
    to: &str,
    body: &str,
    size: i64,
) -> PostOutcome {
    let known = conn
        .query_row(
            "SELECT 1 FROM mail_ids WHERE sender = ?1 AND id = ?2",
            params![from, id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .ok()
        .flatten()
        .is_some();
    if known {
        let still = conn
            .query_row(
                "SELECT pushed FROM mail WHERE sender = ?1 AND id = ?2",
                params![from, id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .ok()
            .flatten();
        let status = match still {
            Some(1) => "delivered",
            Some(_) => "stored",
            None => "delivered",
        };
        return PostOutcome::Duplicate { status };
    }

    if !quota_ok(conn, to, from, size) {
        return PostOutcome::Failed("quota");
    }
    let ts = unix_ms();
    if conn
        .execute(
            "INSERT INTO mail_ids (sender, id, recipient, ts) VALUES (?1, ?2, ?3, ?4)",
            params![from, id, to, ts],
        )
        .is_err()
    {
        return PostOutcome::Failed("invalid");
    }
    if conn
        .execute(
            "INSERT INTO mail (sender, id, recipient, ts, body, size, pushed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![from, id, to, ts, body, size],
        )
        .is_err()
    {
        return PostOutcome::Failed("invalid");
    }
    PostOutcome::Stored
}

fn quota_ok(conn: &Connection, recipient: &str, sender: &str, new_size: i64) -> bool {
    let count: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mail WHERE recipient = ?1",
            params![recipient],
            |r| r.get(0),
        )
        .unwrap_or(MAIL_PER_RECIPIENT);
    if count >= MAIL_PER_RECIPIENT {
        return false;
    }
    let bytes: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(size), 0) FROM mail WHERE recipient = ?1",
            params![recipient],
            |r| r.get(0),
        )
        .unwrap_or(MAIL_BYTES_PER_RECIPIENT);
    if bytes.saturating_add(new_size) > MAIL_BYTES_PER_RECIPIENT {
        return false;
    }
    let pair: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM mail WHERE sender = ?1 AND recipient = ?2",
            params![sender, recipient],
            |r| r.get(0),
        )
        .unwrap_or(MAIL_PER_PAIR);
    pair < MAIL_PER_PAIR
}

fn list_sql(conn: &Connection, recipient: &str) -> Vec<MailRow> {
    let mut stmt = match conn.prepare(
        "SELECT sender, id, ts, body, pushed FROM mail WHERE recipient = ?1 ORDER BY ts ASC",
    ) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let rows = stmt.query_map(params![recipient], |row| {
        let body_raw: String = row.get(3)?;
        let body = serde_json::from_str(&body_raw).unwrap_or(Value::Null);
        Ok(MailRow {
            from: row.get(0)?,
            id: row.get(1)?,
            ts: row.get(2)?,
            body,
            pushed: row.get::<_, i64>(4)? != 0,
        })
    });
    match rows {
        Ok(iter) => iter.flatten().collect(),
        Err(_) => Vec::new(),
    }
}

fn ack_sql(conn: &Connection, recipient: &str, ids: &[String]) {
    let mut stmt = match conn.prepare("DELETE FROM mail WHERE recipient = ?1 AND id = ?2") {
        Ok(s) => s,
        Err(_) => return,
    };
    for id in ids {
        let _ = stmt.execute(params![recipient, id]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn box_open() -> (Mailbox, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let mb = Mailbox::open(&dir.path().join("relay.db")).unwrap();
        (mb, dir)
    }

    #[tokio::test]
    async fn idempotenz_quote_ack() {
        let (mb, _dir) = box_open();
        let body = json!({"c":"x"});
        let a = "bt2_aa";
        let b = "bt2_bb";
        let id = "11111111-1111-1111-1111-111111111111";
        assert_eq!(mb.post(a, id, b, &body).await, PostOutcome::Stored);
        assert_eq!(
            mb.post(a, id, b, &body).await,
            PostOutcome::Duplicate { status: "stored" }
        );
        let listed = mb.list(b).await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, id);
        mb.mark_pushed(a, id).await;
        assert_eq!(
            mb.post(a, id, b, &body).await,
            PostOutcome::Duplicate {
                status: "delivered"
            }
        );
        mb.ack(b, vec![id.to_string()]).await;
        assert!(mb.list(b).await.is_empty());
        assert_eq!(
            mb.post(a, id, b, &body).await,
            PostOutcome::Duplicate {
                status: "delivered"
            }
        );
    }

    #[tokio::test]
    async fn empfaenger_quote() {
        let (mb, _dir) = box_open();
        let body = json!(1);
        let to = "bt2_recv";
        for i in 0..MAIL_PER_RECIPIENT {
            let id = format!("{i:08}-0000-0000-0000-000000000000");
            let from = format!("bt2_{i}");
            assert_eq!(
                mb.post(&from, &id, to, &body).await,
                PostOutcome::Stored,
                "i={i}"
            );
        }
        let id = "ffffffff-0000-0000-0000-000000000000";
        assert_eq!(
            mb.post("bt2_overflow", id, to, &body).await,
            PostOutcome::Failed("quota")
        );
    }

    #[tokio::test]
    async fn paar_quote() {
        let (mb, _dir) = box_open();
        let body = json!(true);
        let from = "bt2_s";
        let to = "bt2_r";
        for i in 0..MAIL_PER_PAIR {
            let id = format!("{i:08}-1111-1111-1111-111111111111");
            assert_eq!(mb.post(from, &id, to, &body).await, PostOutcome::Stored);
        }
        let id = "00000300-1111-1111-1111-111111111111";
        assert_eq!(
            mb.post(from, id, to, &body).await,
            PostOutcome::Failed("quota")
        );
    }
}
