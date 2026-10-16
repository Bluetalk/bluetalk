//! Challenge-Response: Ed25519 über nonce + Host, Peer-ID wie network-core.

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

/// `peerId = "bt2_" + hex(sha256(ed25519PublicKey))`
pub fn peer_id_from_pubkey(public_key: &[u8; 32]) -> String {
    format!("bt2_{}", hex::encode(Sha256::digest(public_key)))
}

/// Signierte UTF-8-Bytes laut PROTOCOL.md.
pub fn auth_payload(nonce_b64: &str, host: &str) -> String {
    format!("bluetalk-relay-auth-v1\n{nonce_b64}\n{host}")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthError {
    Failed,
}

/// Prüft Public Key + Signatur. `nonce_b64` exakt wie im hello, `host` normalisiert.
pub fn verify_auth(
    public_key_b64: &str,
    signature_b64: &str,
    nonce_b64: &str,
    host: &str,
) -> Result<String, AuthError> {
    let pk_raw = BASE64
        .decode(public_key_b64)
        .map_err(|_| AuthError::Failed)?;
    let sig_raw = BASE64
        .decode(signature_b64)
        .map_err(|_| AuthError::Failed)?;
    let pk: [u8; 32] = pk_raw.try_into().map_err(|_| AuthError::Failed)?;
    let sig: [u8; 64] = sig_raw.try_into().map_err(|_| AuthError::Failed)?;
    let verifying = VerifyingKey::from_bytes(&pk).map_err(|_| AuthError::Failed)?;
    let payload = auth_payload(nonce_b64, host);
    verifying
        .verify_strict(payload.as_bytes(), &Signature::from_bytes(&sig))
        .map_err(|_| AuthError::Failed)?;
    Ok(peer_id_from_pubkey(&pk))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn key() -> SigningKey {
        SigningKey::from_bytes(&[0x11u8; 32])
    }

    #[test]
    fn peer_id_format_und_stabil() {
        let pk = key().verifying_key().to_bytes();
        let id = peer_id_from_pubkey(&pk);
        assert!(id.starts_with("bt2_"));
        assert_eq!(id.len(), 68);
        assert!(id[4..].bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(id, peer_id_from_pubkey(&pk));
        assert_ne!(id, peer_id_from_pubkey(&[0x22u8; 32]));
    }

    #[test]
    fn signatur_gueltig_und_ungueltig() {
        let sk = key();
        let pk_b64 = BASE64.encode(sk.verifying_key().as_bytes());
        let nonce = BASE64.encode([0xABu8; 32]);
        let host = "bt.henny.dev";
        let payload = auth_payload(&nonce, host);
        let sig_b64 = BASE64.encode(sk.sign(payload.as_bytes()).to_bytes());
        let id = verify_auth(&pk_b64, &sig_b64, &nonce, host).expect("ok");
        assert_eq!(id, peer_id_from_pubkey(&sk.verifying_key().to_bytes()));

        assert_eq!(
            verify_auth(&pk_b64, &sig_b64, &nonce, "other.host"),
            Err(AuthError::Failed)
        );
        let bad_sig = BASE64.encode([0u8; 64]);
        assert_eq!(
            verify_auth(&pk_b64, &bad_sig, &nonce, host),
            Err(AuthError::Failed)
        );
    }
}
