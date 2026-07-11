#[path = "../src/plugin_manager.rs"]
mod plugin_manager;

use std::{collections::BTreeSet, fs, path::Path};

use plugin_manager::{
    BundledSeedOptions, InstallOptions, PermissionRegistry, PluginError, PluginLimits,
    PluginManager, PluginOrigin, PluginPayloadFile, PLUGIN_MANIFEST_FILE, validate_payload_path,
};
use semver::Version;
use serde_json::json;
use tempfile::TempDir;

fn manager(temp: &TempDir) -> PluginManager {
    PluginManager::new(
        temp.path().join("plugins"),
        Version::new(2, 0, 0),
        PluginLimits::default(),
        PermissionRegistry::default(),
    )
    .unwrap()
}

fn manifest(
    id: &str,
    version: &str,
    permissions: &[&str],
    ui_entry: &str,
) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({
        "schemaVersion": 2,
        "id": id,
        "name": format!("Plugin {id}"),
        "version": version,
        "apiVersion": "^2.0",
        "description": "A test plugin",
        "ui": { "entry": ui_entry },
        "permissions": permissions,
        "autoEnable": true,
        "metadata": { "test": true }
    }))
    .unwrap()
}

fn payload(
    id: &str,
    version: &str,
    permissions: &[&str],
) -> Vec<PluginPayloadFile> {
    vec![
        PluginPayloadFile::new(
            PLUGIN_MANIFEST_FILE,
            manifest(id, version, permissions, "ui/index.html"),
        ),
        PluginPayloadFile::new("ui/index.html", b"<script type=module src=app.js></script>"),
        PluginPayloadFile::new("ui/app.js", b"import './feature.js';"),
        PluginPayloadFile::new("ui/feature.js", b"export const feature = true;"),
        PluginPayloadFile::new("ui/theme.css", b":root { color: blue; }"),
        PluginPayloadFile::new("ui/assets/icon.svg", b"<svg></svg>"),
    ]
}

fn install_options(
    origin: PluginOrigin,
    replace_existing: bool,
    enabled: Option<bool>,
    grants: &[&str],
) -> InstallOptions {
    InstallOptions {
        origin,
        replace_existing,
        allow_downgrade: false,
        enabled,
        grants: grants.iter().map(|value| (*value).to_owned()).collect(),
        expected_id: None,
    }
}

fn write_package(
    root: &Path,
    id: &str,
    version: &str,
    permissions: &[&str],
) {
    let plugin = root.join(id);
    fs::create_dir_all(plugin.join("ui/assets")).unwrap();
    fs::write(
        plugin.join(PLUGIN_MANIFEST_FILE),
        manifest(id, version, permissions, "ui/index.html"),
    )
    .unwrap();
    fs::write(plugin.join("ui/index.html"), "<main>plugin</main>").unwrap();
    fs::write(plugin.join("ui/assets/app.js"), "export {};").unwrap();
}

#[test]
fn validates_manifest_v2_schema_api_and_permissions() {
    let limits = PluginLimits::default();
    let permissions = PermissionRegistry::default();
    let parsed = plugin_manager::PluginManifestV2::parse_and_validate(
        &manifest("valid-plugin", "2.4.1", &["storage:read"], "ui/index.html"),
        &Version::new(2, 0, 0),
        &permissions,
        &limits,
    )
    .unwrap();
    assert_eq!(parsed.id, "valid-plugin");
    assert_eq!(parsed.version, Version::new(2, 4, 1));

    // Trusted bundled UI uses a `.js` renderer entry instead of sandboxed HTML.
    let renderer = json!({
        "schemaVersion": 2,
        "id": "bundled-game",
        "name": "Bundled Game",
        "version": "1.0.0",
        "apiVersion": "^2.0",
        "ui": { "entry": "ui.js", "kind": "trusted-renderer" },
        "permissions": ["ui:tab"],
        "autoEnable": true
    });
    plugin_manager::PluginManifestV2::parse_and_validate(
        &serde_json::to_vec(&renderer).unwrap(),
        &Version::new(2, 0, 0),
        &permissions,
        &limits,
    )
    .expect("trusted-renderer .js entry must validate");

    // A trusted-renderer entry that is not `.js` must be rejected.
    let renderer_bad = json!({
        "schemaVersion": 2,
        "id": "bundled-bad",
        "name": "Bundled Bad",
        "version": "1.0.0",
        "apiVersion": "^2.0",
        "ui": { "entry": "ui.html", "kind": "trusted-renderer" },
        "permissions": [],
        "autoEnable": true
    });
    assert!(plugin_manager::PluginManifestV2::parse_and_validate(
        &serde_json::to_vec(&renderer_bad).unwrap(),
        &Version::new(2, 0, 0),
        &permissions,
        &limits,
    )
    .is_err());

    let wrong_schema = json!({
        "schemaVersion": 1,
        "id": "legacy",
        "name": "Legacy",
        "version": "1.0.0",
        "apiVersion": "^2",
        "ui": {"entry": "ui/index.html"},
        "permissions": []
    });
    let error = plugin_manager::PluginManifestV2::parse_and_validate(
        &serde_json::to_vec(&wrong_schema).unwrap(),
        &Version::new(2, 0, 0),
        &permissions,
        &limits,
    )
    .unwrap_err();
    assert!(matches!(error, PluginError::InvalidManifest(_)));

    let wrong_api = manifest("wrong-api", "1.0.0", &[], "ui/index.html");
    let mut value: serde_json::Value = serde_json::from_slice(&wrong_api).unwrap();
    value["apiVersion"] = json!("^3");
    let error = plugin_manager::PluginManifestV2::parse_and_validate(
        &serde_json::to_vec(&value).unwrap(),
        &Version::new(2, 0, 0),
        &permissions,
        &limits,
    )
    .unwrap_err();
    assert!(matches!(error, PluginError::InvalidManifest(_)));

    let unknown = manifest("unknown-permission", "1.0.0", &["shell:execute"], "ui/index.html");
    assert!(matches!(
        plugin_manager::PluginManifestV2::parse_and_validate(
            &unknown,
            &Version::new(2, 0, 0),
            &permissions,
            &limits,
        ),
        Err(PluginError::UnknownPermission(_))
    ));

    let duplicate = manifest(
        "duplicate-permission",
        "1.0.0",
        &["storage:read", "storage:read"],
        "ui/index.html",
    );
    assert!(matches!(
        plugin_manager::PluginManifestV2::parse_and_validate(
            &duplicate,
            &Version::new(2, 0, 0),
            &permissions,
            &limits,
        ),
        Err(PluginError::InvalidManifest(_))
    ));
}

#[test]
fn rejects_ambiguous_cross_platform_paths() {
    let limits = PluginLimits::default();
    for invalid in [
        "",
        "/absolute.js",
        "../escape.js",
        "a/../../escape.js",
        "a\\windows.js",
        "C:/drive.js",
        "//server/share.js",
        "ui/%2e%2e/app.js",
        "ui/app.js:stream",
        "ui/CON.txt",
        "ui/Lpt9",
        "ui/.hidden",
        "ui/trailing.",
        "ui/naïve.js",
        "ui/space name.js",
    ] {
        assert!(
            validate_payload_path(invalid, &limits).is_err(),
            "path should be rejected: {invalid}"
        );
    }
    assert_eq!(
        validate_payload_path("ui/assets/app-2.0+prod.js", &limits).unwrap(),
        Path::new("ui/assets/app-2.0+prod.js")
    );
}

#[test]
fn installs_and_persists_a_real_multi_file_payload() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("plugins");
    let manager = manager(&temp);
    let record = manager
        .install_payload(
            payload(
                "multi-file",
                "1.0.0",
                &["storage:read", "ui:tab"],
            ),
            InstallOptions::default(),
        )
        .unwrap();
    assert!(!record.enabled);
    assert_eq!(record.file_count, 6);
    assert!(root.join("multi-file/ui/feature.js").is_file());
    assert!(root.join("multi-file/ui/assets/icon.svg").is_file());
    assert!(matches!(
        manager.set_enabled("multi-file", true),
        Err(PluginError::MissingPermissions { .. })
    ));

    manager.grant("multi-file", "storage:read").unwrap();
    manager.grant("multi-file", "ui:tab").unwrap();
    let enabled = manager.set_enabled("multi-file", true).unwrap();
    assert!(enabled.enabled);
    drop(manager);

    let reopened = PluginManager::new(
        root,
        Version::new(2, 0, 0),
        PluginLimits::default(),
        PermissionRegistry::default(),
    )
    .unwrap();
    let persisted = reopened.get("multi-file").unwrap();
    assert!(persisted.enabled);
    assert!(persisted.granted_permissions.contains("storage:read"));
    assert!(persisted.granted_permissions.contains("ui:tab"));
}

#[test]
fn rejects_case_collisions_before_writing_the_target() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp);
    let mut files = payload("collision", "1.0.0", &[]);
    files.push(PluginPayloadFile::new("ui/App.js", b"one"));
    files.push(PluginPayloadFile::new("ui/app.js", b"two"));
    let error = manager
        .install_payload(files, InstallOptions::default())
        .unwrap_err();
    assert!(matches!(error, PluginError::PathCollision { .. }));
    assert!(!manager.root().join("collision").exists());
}

#[test]
fn enforces_file_count_and_size_limits_before_cutover() {
    let temp = tempfile::tempdir().unwrap();
    let limits = PluginLimits {
        max_files: 2,
        max_total_bytes: 1_024,
        max_file_bytes: 512,
        ..PluginLimits::default()
    };
    let manager = PluginManager::new(
        temp.path().join("plugins"),
        Version::new(2, 0, 0),
        limits,
        PermissionRegistry::default(),
    )
    .unwrap();
    let error = manager
        .install_payload(payload("too-many", "1.0.0", &[]), InstallOptions::default())
        .unwrap_err();
    assert!(matches!(error, PluginError::LimitExceeded(_)));
    assert!(!manager.root().join("too-many").exists());
}

#[test]
fn permission_expansion_disables_an_enabled_update_until_granted() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp);
    manager
        .install_payload(
            payload("permission-update", "1.0.0", &["storage:read"]),
            install_options(
                PluginOrigin::User,
                false,
                Some(true),
                &["storage:read"],
            ),
        )
        .unwrap();
    let updated = manager
        .install_payload(
            payload(
                "permission-update",
                "1.1.0",
                &["storage:read", "network:http"],
            ),
            install_options(PluginOrigin::User, true, None, &[]),
        )
        .unwrap();
    assert!(!updated.enabled);
    assert!(updated.granted_permissions.contains("storage:read"));
    assert!(updated.missing_permissions.contains("network:http"));
    assert!(matches!(
        manager.set_enabled("permission-update", true),
        Err(PluginError::MissingPermissions { .. })
    ));
    manager.grant("permission-update", "network:http").unwrap();
    assert!(manager.set_enabled("permission-update", true).unwrap().enabled);
}

#[test]
fn cutover_failure_restores_the_previous_version_and_registry() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp);
    manager
        .install_payload(
            payload("rollback", "1.0.0", &["storage:read"]),
            install_options(
                PluginOrigin::User,
                false,
                Some(true),
                &["storage:read"],
            ),
        )
        .unwrap();
    manager.fail_next_cutover_after_backup_for_test();
    let error = manager
        .install_payload(
            payload("rollback", "2.0.0", &["storage:read"]),
            install_options(PluginOrigin::User, true, None, &[]),
        )
        .unwrap_err();
    assert!(matches!(error, PluginError::Operation(_)));
    assert_eq!(
        manager.get("rollback").unwrap().manifest.version,
        Version::new(1, 0, 0)
    );
    let disk: serde_json::Value = serde_json::from_slice(
        &fs::read(manager.root().join("rollback/manifest.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(disk["version"], "1.0.0");
}

#[test]
fn invalid_update_never_replaces_the_existing_plugin() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp);
    manager
        .install_payload(
            payload("preflight-rollback", "1.0.0", &[]),
            InstallOptions::default(),
        )
        .unwrap();
    let invalid = vec![PluginPayloadFile::new(
        PLUGIN_MANIFEST_FILE,
        manifest("preflight-rollback", "2.0.0", &[], "ui/missing.html"),
    )];
    assert!(manager
        .install_payload(
            invalid,
            install_options(PluginOrigin::User, true, None, &[]),
        )
        .is_err());
    assert_eq!(
        manager.get("preflight-rollback").unwrap().manifest.version,
        Version::new(1, 0, 0)
    );
}

#[test]
fn scan_lists_valid_plugins_and_reports_invalid_directories() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp);
    write_package(manager.root(), "manual", "1.0.0", &[]);
    let invalid = manager.root().join("legacy");
    fs::create_dir_all(&invalid).unwrap();
    fs::write(
        invalid.join(PLUGIN_MANIFEST_FILE),
        r#"{"id":"legacy","version":"1.0.0"}"#,
    )
    .unwrap();
    let report = manager.scan().unwrap();
    assert!(report.plugins.iter().any(|plugin| plugin.id == "manual"));
    assert!(report.rejected.iter().any(|issue| issue.path == invalid));
}

#[test]
fn bundled_seeding_respects_tombstones_and_can_restore() {
    let temp = tempfile::tempdir().unwrap();
    let bundled = temp.path().join("bundled");
    fs::create_dir_all(&bundled).unwrap();
    write_package(&bundled, "bundled-game", "1.0.0", &["ui:tab"]);
    let manager = manager(&temp);

    let first = manager.seed_bundled_from(&bundled, BundledSeedOptions::default());
    assert_eq!(first.installed, vec!["bundled-game"]);
    let installed = manager.get("bundled-game").unwrap();
    assert_eq!(installed.origin, PluginOrigin::Bundled);
    assert!(installed.enabled);
    assert!(installed.granted_permissions.contains("ui:tab"));

    assert!(manager.uninstall("bundled-game").unwrap());
    assert!(manager.is_bundled_removed("bundled-game"));
    let skipped = manager.seed_bundled_from(&bundled, BundledSeedOptions::default());
    assert_eq!(skipped.skipped, vec!["bundled-game"]);
    assert!(manager.get("bundled-game").is_none());

    let restored = manager.seed_bundled_from(
        &bundled,
        BundledSeedOptions {
            restore_removed: true,
            ..BundledSeedOptions::default()
        },
    );
    assert_eq!(restored.installed, vec!["bundled-game"]);
    assert!(!manager.is_bundled_removed("bundled-game"));
}

#[test]
fn bundled_seeding_updates_only_newer_versions() {
    let temp = tempfile::tempdir().unwrap();
    let bundled = temp.path().join("bundled");
    fs::create_dir_all(&bundled).unwrap();
    write_package(&bundled, "versioned", "1.0.0", &[]);
    let manager = manager(&temp);
    assert_eq!(
        manager
            .seed_bundled_from(&bundled, BundledSeedOptions::default())
            .installed,
        vec!["versioned"]
    );
    assert_eq!(
        manager
            .seed_bundled_from(&bundled, BundledSeedOptions::default())
            .skipped,
        vec!["versioned"]
    );

    fs::write(
        bundled.join("versioned/manifest.json"),
        manifest("versioned", "1.1.0", &[], "ui/index.html"),
    )
    .unwrap();
    assert_eq!(
        manager
            .seed_bundled_from(&bundled, BundledSeedOptions::default())
            .updated,
        vec!["versioned"]
    );
    assert_eq!(
        manager.get("versioned").unwrap().manifest.version,
        Version::new(1, 1, 0)
    );
}

#[cfg(unix)]
#[test]
fn directory_install_rejects_symbolic_links() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    fs::create_dir_all(source.join("ui")).unwrap();
    fs::write(
        source.join(PLUGIN_MANIFEST_FILE),
        manifest("linked", "1.0.0", &[], "ui/index.html"),
    )
    .unwrap();
    fs::write(source.join("ui/index.html"), "ok").unwrap();
    let outside = temp.path().join("outside.txt");
    fs::write(&outside, "secret").unwrap();
    symlink(&outside, source.join("ui/leak.txt")).unwrap();

    let manager = manager(&temp);
    assert!(matches!(
        manager.install_from_directory(&source, InstallOptions::default()),
        Err(PluginError::UnsupportedFileType(_))
    ));
    assert!(!manager.root().join("linked").exists());
}

#[test]
fn grants_must_be_requested_and_known() {
    let temp = tempfile::tempdir().unwrap();
    let manager = manager(&temp);
    manager
        .install_payload(
            payload("grant-check", "1.0.0", &["storage:read"]),
            InstallOptions::default(),
        )
        .unwrap();
    assert!(matches!(
        manager.set_grants("grant-check", ["chat:send"]),
        Err(PluginError::PermissionNotRequested { .. })
    ));
    assert!(matches!(
        manager.set_grants("grant-check", ["made-up:permission"]),
        Err(PluginError::UnknownPermission(_))
    ));
    assert_eq!(
        manager
            .set_grants(
                "grant-check",
                BTreeSet::from(["storage:read".to_owned()]),
            )
            .unwrap()
            .granted_permissions,
        BTreeSet::from(["storage:read".to_owned()])
    );
}
