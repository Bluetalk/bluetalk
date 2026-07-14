//! Reine Helfer: Herkunfts-Label, lenientes Manifest-Lesen, Legacy-Update-
//! Entscheidung und Versions-Vergleich.

use super::*;

pub(super) fn origin_label(origin: PluginOrigin) -> &'static str {
    match origin {
        PluginOrigin::Bundled => "bundled",
        PluginOrigin::User => "user",
    }
}

/// Reads a manifest without v2 schema validation (legacy v1 packages).
pub(super) fn read_lenient_manifest(dir: &Path) -> Option<Value> {
    let path = dir.join(PLUGIN_MANIFEST_FILE);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > MAX_LEGACY_MANIFEST_BYTES
    {
        return None;
    }
    let bytes = fs::read(&path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value.is_object().then_some(value)
}

/// v1 update rule: a strictly higher manifest version updates; as a dev
/// convenience a newer bundled `ui.js` (same version) also updates.
pub(super) fn legacy_should_update(source: &Path, target: &Path) -> bool {
    let source_version = manifest_version(source);
    let target_version = manifest_version(target);
    if lenient_version_cmp(&source_version, &target_version) == Ordering::Greater {
        return true;
    }
    match (
        fs::metadata(source.join("ui.js")).and_then(|metadata| metadata.modified()),
        fs::metadata(target.join("ui.js")).and_then(|metadata| metadata.modified()),
    ) {
        (Ok(source_time), Ok(target_time)) => source_time > target_time,
        _ => false,
    }
}

fn manifest_version(dir: &Path) -> String {
    read_lenient_manifest(dir)
        .and_then(|manifest| {
            manifest
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .unwrap_or_else(|| "0.0.0".to_owned())
}

/// Compares versions: exact semver when both parse, otherwise a numeric
/// dot-part comparison (v1 `compareVersionParts`).
fn lenient_version_cmp(a: &str, b: &str) -> Ordering {
    match (Version::parse(a), Version::parse(b)) {
        (Ok(a), Ok(b)) => a.cmp(&b),
        _ => {
            let a = numeric_parts(a);
            let b = numeric_parts(b);
            let length = a.len().max(b.len());
            for index in 0..length {
                let left = a.get(index).copied().unwrap_or(0);
                let right = b.get(index).copied().unwrap_or(0);
                match left.cmp(&right) {
                    Ordering::Equal => {}
                    unequal => return unequal,
                }
            }
            Ordering::Equal
        }
    }
}

fn numeric_parts(version: &str) -> Vec<u64> {
    version
        .split('.')
        .map(|part| {
            let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
            digits.parse().unwrap_or(0)
        })
        .collect()
}
