import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('CSP blocks eval and Tauri globals', async () => {
  const [html, config, runtime] = await Promise.all([
    readFile(path.join(root, 'index.html'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'src', 'renderer', 'plugins', 'pluginRuntime.js'), 'utf8'),
  ]);

  assert.doesNotMatch(html, /unsafe-eval/);
  assert.doesNotMatch(config.app.security.csp, /unsafe-eval/);
  assert.equal(config.app.withGlobalTauri, false);
  assert.doesNotMatch(runtime, /new Function\s*\(/);
  assert.match(runtime, /third-party UI refused/);
});

test('custom commands are ACL-managed and auxiliary windows cannot read app storage', async () => {
  const [buildScript, mainCapability, gameCapability] = await Promise.all([
    readFile(path.join(root, 'src-tauri', 'build.rs'), 'utf8'),
    readFile(path.join(root, 'src-tauri', 'capabilities', 'main.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'src-tauri', 'capabilities', 'game-windows.json'), 'utf8').then(JSON.parse),
  ]);

  assert.match(buildScript, /AppManifest::new\(\)\.commands\(COMMANDS\)/);
  assert.ok(mainCapability.permissions.includes('allow-store-get'));
  assert.ok(mainCapability.permissions.includes('allow-messages-get-batch'));
  assert.ok(!gameCapability.permissions.some((permission) => /store|messages|plugins|updater/.test(permission)));
  assert.ok(!gameCapability.windows.includes('*'));
});

test('trusted bundled plugin UIs are importable ESM modules', async () => {
  const ids = [
    'chess',
    'connect-four',
    'hello',
    'live-docs',
    'poker',
    'theme-studio',
    'tic-tac-toe',
    'uno',
  ];
  for (const id of ids) {
    const url = pathToFileURL(path.join(root, 'assets', 'bundled-plugins', id, 'ui.js')).href;
    const module = await import(`${url}?test=${Date.now()}-${id}`);
    assert.equal(typeof module.default, 'function', `${id} must export an activation function`);
  }
});

test('release version is synchronized across package, Tauri and Cargo', async () => {
  const [pkg, config, cargo] = await Promise.all([
    readFile(path.join(root, 'package.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'src-tauri', 'tauri.conf.json'), 'utf8').then(JSON.parse),
    readFile(path.join(root, 'src-tauri', 'Cargo.toml'), 'utf8'),
  ]);
  assert.equal(config.version, pkg.version);
  assert.match(cargo, new RegExp(`version = "${pkg.version.replaceAll('.', '\\.')}"`));
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.match(config.plugins.updater.pubkey, /^[A-Za-z0-9+/=]+$/);
});

