//! Duplex-Brücke zwischen Relay-Binärframes und dem Peer-Protokoll-Stream.

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, DuplexStream},
    sync::{mpsc, watch},
};

use super::{
    config::{DUPLEX_BUFFER, MAX_TUNNEL_PAYLOAD},
    WsOut,
};

pub struct TunnelBridge {
    pub inbound: mpsc::Sender<Vec<u8>>,
    pub close: watch::Sender<bool>,
}

pub fn new_duplex() -> (DuplexStream, DuplexStream) {
    tokio::io::duplex(DUPLEX_BUFFER)
}

pub fn encode_frame(tunnel_id: u32, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&tunnel_id.to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

pub fn decode_frame(data: &[u8]) -> Option<(u32, &[u8])> {
    if data.len() < 4 {
        return None;
    }
    let tunnel_id = u32::from_be_bytes(data[0..4].try_into().ok()?);
    if tunnel_id == 0 {
        return None;
    }
    Some((tunnel_id, &data[4..]))
}

pub fn spawn_bridge(
    tunnel_id: u32,
    stream: DuplexStream,
    ws_out: mpsc::Sender<WsOut>,
    ended: mpsc::Sender<u32>,
) -> TunnelBridge {
    let (inbound_tx, mut inbound_rx) = mpsc::channel::<Vec<u8>>(32);
    let (close_tx, mut close_rx) = watch::channel(false);
    let close_notify = close_tx.clone();
    let mut writer_close = close_tx.subscribe();
    tokio::spawn(async move {
        let (mut read_half, mut write_half) = tokio::io::split(stream);
        let writer = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = writer_close.changed() => break,
                    chunk = inbound_rx.recv() => {
                        let Some(bytes) = chunk else { break };
                        if write_half.write_all(&bytes).await.is_err() {
                            break;
                        }
                    }
                }
            }
        });

        let mut buf = vec![0_u8; MAX_TUNNEL_PAYLOAD];
        loop {
            tokio::select! {
                _ = close_rx.changed() => break,
                read = read_half.read(&mut buf) => match read {
                    Ok(0) => break,
                    Ok(n) => {
                        let payload = buf[..n].to_vec();
                        if ws_out
                            .send(WsOut::Binary {
                                tunnel_id,
                                payload,
                            })
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                },
            }
        }

        let _ = ws_out
            .send(WsOut::Json(serde_json::json!({ "t": "close", "tunnel": tunnel_id })))
            .await;
        let _ = close_notify.send(true);
        writer.abort();
        let _ = writer.await;
        let _ = ended.send(tunnel_id).await;
    });

    TunnelBridge {
        inbound: inbound_tx,
        close: close_tx,
    }
}
