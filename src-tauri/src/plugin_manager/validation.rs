//! Validierung von Plugin-IDs, Manifest-Feldern, Berechtigungsnamen und
//! Payload-Pfaden (Sandbox-Prüfung).

use super::*;

pub(super) fn validate_permission_name(permission: &str) -> Result<()> {
    if permission.is_empty() || permission.len() > 96 || !permission.is_ascii() {
        return Err(PluginError::UnknownPermission(permission.to_owned()));
    }
    let mut parts = permission.split(':');
    let Some(namespace) = parts.next() else {
        return Err(PluginError::UnknownPermission(permission.to_owned()));
    };
    let Some(action) = parts.next() else {
        return Err(PluginError::UnknownPermission(permission.to_owned()));
    };
    if parts.next().is_some()
        || namespace.is_empty()
        || action.is_empty()
        || !namespace
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        || !action
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(PluginError::UnknownPermission(permission.to_owned()));
    }
    Ok(())
}

pub fn validate_plugin_id(id: &str) -> Result<()> {
    const RESERVED: [&str; 3] = ["constructor", "prototype", "__proto__"];
    let valid = !id.is_empty()
        && id.len() <= 64
        && id.is_ascii()
        && !RESERVED.contains(&id)
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'_' | b'.'))
        && id
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && id
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_alphanumeric);
    if !valid {
        return Err(PluginError::InvalidManifest(format!(
            "invalid plugin id `{id}`"
        )));
    }
    Ok(())
}

pub(super) fn validate_trimmed_field(name: &str, value: &str, min: usize, max: usize) -> Result<()> {
    if value.trim() != value || value.len() < min || value.len() > max || value.contains('\0') {
        return Err(PluginError::InvalidManifest(format!(
            "{name} must be trimmed and between {min} and {max} bytes"
        )));
    }
    Ok(())
}

pub(super) fn validate_optional_field(name: &str, value: &str, max: usize) -> Result<()> {
    if value.len() > max || value.contains('\0') {
        return Err(PluginError::InvalidManifest(format!(
            "{name} exceeds {max} bytes"
        )));
    }
    Ok(())
}

pub(super) fn validate_optional_string(name: &str, value: Option<&str>, max: usize) -> Result<()> {
    if let Some(value) = value {
        if value.trim() != value || value.is_empty() || value.len() > max || value.contains('\0') {
            return Err(PluginError::InvalidManifest(format!(
                "{name} must be non-empty, trimmed and at most {max} bytes"
            )));
        }
    }
    Ok(())
}

/// Validates a canonical package-relative path and returns its platform path.
///
/// Package paths intentionally use a conservative ASCII alphabet. Apart from
/// making package URLs predictable this prevents NFC/NFD and Unicode case-fold
/// aliases across Windows, macOS and Linux without trusting the host filesystem.
pub fn validate_payload_path(raw: &str, limits: &PluginLimits) -> Result<PathBuf> {
    if raw.is_empty() {
        return invalid_path(raw, "path is empty");
    }
    if !raw.is_ascii() {
        return invalid_path(raw, "package paths must be ASCII");
    }
    if raw.len() > limits.max_relative_path_bytes {
        return invalid_path(raw, "path is too long");
    }
    if raw.starts_with('/') || raw.starts_with('\\') || raw.contains('\\') {
        return invalid_path(raw, "absolute, UNC and backslash paths are forbidden");
    }
    if raw.contains(':') || raw.contains('%') || raw.contains('?') || raw.contains('#') {
        return invalid_path(raw, "path contains an ambiguous or reserved character");
    }

    let parts: Vec<&str> = raw.split('/').collect();
    if parts.len() > limits.max_depth {
        return invalid_path(raw, "path nesting is too deep");
    }
    let mut path = PathBuf::new();
    for part in parts {
        if part.is_empty() || part == "." || part == ".." {
            return invalid_path(raw, "empty, dot and parent components are forbidden");
        }
        if part.len() > limits.max_component_bytes {
            return invalid_path(raw, "a path component is too long");
        }
        if part.starts_with('.') || part.ends_with('.') || part.ends_with(' ') {
            return invalid_path(raw, "hidden and trailing-dot/space components are forbidden");
        }
        if !part.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'@' | b'+')
        }) {
            return invalid_path(raw, "path contains unsupported characters");
        }
        if is_windows_reserved_component(part) {
            return invalid_path(raw, "path uses a reserved Windows device name");
        }
        path.push(part);
    }
    Ok(path)
}

fn invalid_path<T>(raw: &str, reason: &str) -> Result<T> {
    Err(PluginError::InvalidPath {
        path: raw.to_owned(),
        reason: reason.to_owned(),
    })
}

fn is_windows_reserved_component(component: &str) -> bool {
    let stem = component
        .split('.')
        .next()
        .unwrap_or(component)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"))
            .is_some_and(|suffix| {
                suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9')
            })
}

pub(super) fn collision_key(path: &str) -> String {
    path.to_ascii_lowercase()
}
