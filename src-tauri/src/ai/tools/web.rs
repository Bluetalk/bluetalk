//! Web-Fetch mit SSRF-Schutz (blockierte Hostnamen/IP-Bereiche).

use super::*;

fn is_blocked_fetch_hostname(hostname: &str) -> bool {
    let raw = hostname
        .trim()
        .to_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_string();
    if raw.is_empty() {
        return true;
    }
    if raw == "localhost" || raw.ends_with(".localhost") {
        return true;
    }

    if let Ok(ip) = raw.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(v4) => {
                let octets = v4.octets();
                let (a, b) = (octets[0], octets[1]);
                return a == 0
                    || a == 10
                    || a == 127
                    || (a == 169 && b == 254)
                    || (a == 172 && (16..=31).contains(&b))
                    || (a == 192 && b == 168)
                    || (a == 100 && (64..=127).contains(&b))
                    || a >= 224;
            }
            IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unspecified() {
                    return true;
                }
                let segments = v6.segments();
                // Link-local fe80::/10, ULA fc00::/7
                if (segments[0] & 0xffc0) == 0xfe80 || (segments[0] & 0xfe00) == 0xfc00 {
                    return true;
                }
                if let Some(mapped) = v6.to_ipv4_mapped() {
                    return is_blocked_fetch_hostname(&mapped.to_string());
                }
                return false;
            }
        }
    }

    false
}

pub(super) async fn tool_web_fetch(args: &Value) -> Value {
    let mut target = arg_str(args, "url").trim().to_string();
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => return json!({"ok": false, "error": error.to_string()}),
    };

    for _redirect in 0..=5 {
        let parsed = match url::Url::parse(&target) {
            Ok(parsed) => parsed,
            Err(_) => return json!({"ok": false, "error": "invalid_url"}),
        };
        if parsed.scheme() != "http" && parsed.scheme() != "https" {
            return json!({"ok": false, "error": "invalid_url"});
        }
        let host = parsed.host_str().unwrap_or("");
        if is_blocked_fetch_hostname(host) {
            return json!({"ok": false, "error": "blocked_private_url"});
        }

        let response = match client.get(parsed.as_str()).send().await {
            Ok(response) => response,
            Err(error) => {
                let message = if error.is_timeout() {
                    "timeout".to_string()
                } else {
                    error.to_string()
                };
                return json!({"ok": false, "error": message});
            }
        };
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if location.is_empty() {
                return json!({"ok": false, "error": format!("http_{}", status.as_u16())});
            }
            target = match url::Url::parse(&target).ok().and_then(|base| base.join(location).ok()) {
                Some(next) => next.to_string(),
                None => return json!({"ok": false, "error": "invalid_url"}),
            };
            continue;
        }
        if !status.is_success() {
            return json!({"ok": false, "error": format!("http_{}", status.as_u16())});
        }

        let mut response = response;
        let mut body: Vec<u8> = Vec::new();
        loop {
            match response.chunk().await {
                Ok(Some(chunk)) => {
                    if body.len() + chunk.len() > WEB_FETCH_MAX_BYTES {
                        let remaining = WEB_FETCH_MAX_BYTES.saturating_sub(body.len());
                        body.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
                        break;
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(None) => break,
                Err(error) => return json!({"ok": false, "error": error.to_string()}),
            }
        }
        let text = String::from_utf8_lossy(&body).to_string();
        return json!({
            "ok": true,
            "url": target,
            "statusCode": status.as_u16(),
            "content": truncate_chars(&text, 200_000),
        });
    }
    json!({"ok": false, "error": "too_many_redirects"})
}

// ---------------------------------------------------------------------------
// ask_user / Bestätigungs-Gate
// ---------------------------------------------------------------------------

