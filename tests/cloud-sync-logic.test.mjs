import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEVICE_LOCAL_SETTINGS_KEYS,
  FILE_DATA_STRIP_BYTES,
  applyStoreEntryToValue,
  createMemoryOutbox,
  diffStoreEntries,
  dropOutboxIfRemoteNewer,
  entriesOfStore,
  logicalKeyOf,
  mergeOutbox,
  pendingTsFor,
  prepareMessageForSync,
  removeSentFromOutbox,
  shouldApplyMessage,
  shouldApplyStoreEntry,
  shouldApplyStoreOp,
  shouldSkipOwnOrigin,
  utf8ByteLength,
} from '../src/renderer/cloudAccount/syncLogic.js';
import { wrapWithSync, setSyncSink, withoutSync, getRawApi, SYNCED_STORE_KEYS } from '../src/bridge/syncLayer.js';

test('prepareMessageForSync strips fileData larger than 1.5 MiB', () => {
  const small = prepareMessageForSync({ messageId: 'a', fileData: 'data:text/plain,hi' });
  assert.equal(small.fileData, 'data:text/plain,hi');
  assert.equal(small.syncStripped, undefined);

  const payload = 'x'.repeat(FILE_DATA_STRIP_BYTES + 8);
  const big = prepareMessageForSync({ messageId: 'b', fileData: payload, content: 'ok' });
  assert.equal(big.fileData, undefined);
  assert.equal(big.syncStripped, true);
  assert.equal(big.content, 'ok');
  assert.ok(utf8ByteLength(payload) > FILE_DATA_STRIP_BYTES);
});

test('store conflicts: newer or equal ts wins', () => {
  assert.equal(shouldApplyStoreOp(200, 100), true);
  assert.equal(shouldApplyStoreOp(100, 100), true);
  assert.equal(shouldApplyStoreOp(50, 100), false);
});

test('messages at or before a chat-del tombstone are ignored', () => {
  assert.equal(shouldApplyMessage({ timestamp: 50 }, 100), false);
  assert.equal(shouldApplyMessage({ timestamp: 100 }, 100), false);
  assert.equal(shouldApplyMessage({ timestamp: 101 }, 100), true);
  assert.equal(shouldApplyMessage({ timestamp: 1 }, 0), true);
});

test('mergeOutbox replaces the same logical key and chat-del drops that chat', () => {
  let box = [];
  box = mergeOutbox(box, { type: 'msg', peerId: 'p1', messageId: 'm1', ts: 1 });
  box = mergeOutbox(box, { type: 'msg', peerId: 'p1', messageId: 'm1', ts: 2 });
  box = mergeOutbox(box, { type: 'store', key: 'contacts', ts: 3 });
  assert.equal(box.filter((item) => item.type === 'msg').length, 1);
  assert.equal(logicalKeyOf(box[0]), 'msg:p1:m1');
  box = mergeOutbox(box, { type: 'chat-del', peerId: 'p1', ts: 4 });
  assert.equal(box.some((item) => item.type === 'msg'), false);
  assert.equal(box.some((item) => item.type === 'chat-del' && item.peerId === 'p1'), true);
  assert.equal(box.some((item) => item.type === 'store'), true);
});

test('dropOutboxIfRemoteNewer keeps only locally newer changes', () => {
  const box = [
    { type: 'store', key: 'settings', ts: 10 },
    { type: 'store', key: 'contacts', ts: 50 },
  ];
  const next = dropOutboxIfRemoteNewer(box, 'store:settings', 20);
  assert.equal(next.some((item) => item.key === 'settings'), false);
  assert.equal(next.some((item) => item.key === 'contacts'), true);
});

test('wrapWithSync reports store and message changes only on success', async () => {
  const seen = [];
  setSyncSink({ onLocalChange: (change) => seen.push(change) });
  const api = wrapWithSync({
    store: {
      get: async () => null,
      set: async () => true,
      delete: async () => true,
    },
    messages: {
      append: async () => ({ appended: true }),
      patch: async () => true,
      deleteMessage: async () => true,
      deleteChat: async () => true,
    },
  });
  await api.store.set('contacts', []);
  await api.store.set('theme', 'dark');
  await api.messages.append('p1', { messageId: 'm1' });
  await withoutSync((raw) => raw.store.set('settings', {}));
  assert.equal(getRawApi().store.set !== api.store.set, true);
  setSyncSink(null);
  assert.deepEqual(seen, [
    { type: 'store', key: 'contacts' },
    { type: 'msg', peerId: 'p1', messageId: 'm1' },
  ]);
  assert.ok(SYNCED_STORE_KEYS.includes('e2eeSessions'));
});

test('withoutSync has no global counter: wrapped writes still report during raw apply', async () => {
  const seen = [];
  setSyncSink({ onLocalChange: (change) => seen.push(change) });
  const api = wrapWithSync({
    store: {
      get: async () => null,
      set: async () => true,
      delete: async () => true,
    },
    messages: { append: async () => ({ appended: true }) },
  });
  const apply = withoutSync(async (raw) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await raw.store.set('contacts', [{ id: 'from-remote' }]);
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await api.store.set('groups', [{ id: 'group:local' }]);
  await apply;
  setSyncSink(null);
  assert.equal(seen.some((change) => change.key === 'groups'), true);
  assert.equal(seen.some((change) => change.key === 'contacts'), false);
});

test('settings exclusion list covers device-local fields', () => {
  const required = [
    'peerPort',
    'peerPorts',
    'apiPort',
    'autoUpdateEnabled',
    'autoDownloadUpdates',
    'minimizeToTray',
    'launchAtLogin',
    'debugMode',
    'windowsNotifications',
    'uiResize',
    'uiCollapse',
    'onboardingUsernameDone',
  ];
  for (const key of required) {
    assert.ok(DEVICE_LOCAL_SETTINGS_KEYS.includes(key), `fehlt: ${key}`);
  }
  const settings = {
    displayName: 'Ada',
    theme: 'dark',
    launchAtLogin: true,
    uiResize: { sidebar: 200 },
    windowsNotifications: false,
  };
  const entries = entriesOfStore('settings', settings);
  assert.equal(entries.displayName, 'Ada');
  assert.equal(entries.theme, 'dark');
  assert.equal(entries.launchAtLogin, undefined);
  assert.equal(entries.uiResize, undefined);
  assert.equal(entries.windowsNotifications, undefined);
});

test('per-entry diff: lastSeen-Update enqueued ohne den restlichen Kontakt-Blob', () => {
  const snapshot = entriesOfStore('contacts', [
    { id: 'a', name: 'A' },
    { id: 'c', name: 'C', lastSeen: 1 },
  ]);
  const current = [
    { id: 'a', name: 'A' },
    { id: 'c', name: 'C', lastSeen: 2 },
  ];
  const diffs = diffStoreEntries('contacts', current, snapshot);
  assert.equal(diffs.length, 1);
  assert.equal(diffs[0].type, 'store-entry');
  assert.equal(diffs[0].id, 'c');
  assert.equal(diffs[0].value.lastSeen, 2);
});

test('Datenverlust-Szenario: Kontakt X von Gerät A überlebt lastSeen-Update von Gerät B', () => {
  let localB = [
    { id: 'a', name: 'A' },
    { id: 'c', name: 'C', lastSeen: 2 },
  ];
  localB = applyStoreEntryToValue('contacts', localB, 'x', { value: { id: 'x', name: 'X' } });
  assert.equal(localB.some((row) => row.id === 'x'), true);
  assert.equal(localB.find((row) => row.id === 'c').lastSeen, 2);
  const snapshotA = entriesOfStore('contacts', [{ id: 'a', name: 'A' }, { id: 'x', name: 'X' }]);
  const diffs = diffStoreEntries('contacts', localB, snapshotA);
  assert.equal(diffs.some((row) => row.id === 'c'), true);
  assert.equal(diffs.some((row) => row.id === 'x' && row.deleted), false);
});

test('Datenverlust-Szenario: neuerer lokaler Eintrag gewinnt gegen eigenes Echo', () => {
  assert.equal(shouldApplyStoreEntry({ incomingTs: 100, appliedTs: 50, pendingLocalTs: 200 }), false);
  assert.equal(shouldApplyStoreEntry({ incomingTs: 100, appliedTs: 50, pendingLocalTs: 0 }), true);
  assert.equal(shouldApplyStoreEntry({ incomingTs: 100, appliedTs: 100, pendingLocalTs: 90 }), true);
  const outbox = [{ type: 'store-entry', key: 'contacts', id: 'x', ts: 200, value: { id: 'x', name: 'neu' } }];
  assert.equal(pendingTsFor(outbox, 'store:contacts:x'), 200);
  let local = [{ id: 'x', name: 'neu' }];
  if (shouldApplyStoreEntry({
    incomingTs: 100,
    appliedTs: 0,
    pendingLocalTs: pendingTsFor(outbox, 'store:contacts:x'),
  })) {
    local = applyStoreEntryToValue('contacts', local, 'x', { value: { id: 'x', name: 'alt' } });
  }
  assert.equal(local[0].name, 'neu');
});

test('origin-Skip: eigene Ops werden nicht angewandt', () => {
  const origin = 'device-a';
  assert.equal(shouldSkipOwnOrigin({ t: 'store-entry', origin: 'device-a' }, origin), true);
  assert.equal(shouldSkipOwnOrigin({ t: 'store-entry', origin: 'device-b' }, origin), false);
  assert.equal(shouldSkipOwnOrigin({ t: 'msg' }, origin), false);
});

test('Outbox-Mutationen während eines laufenden Push entfernen nur gesendete Einträge', () => {
  const box = createMemoryOutbox([
    { type: 'msg', peerId: 'p', messageId: 'm1', ts: 1 },
    { type: 'msg', peerId: 'p', messageId: 'm2', ts: 2 },
  ]);
  const sending = box.snapshot().slice(0, 1);
  box.enqueue({ type: 'msg', peerId: 'p', messageId: 'm3', ts: 3 });
  box.enqueue({ type: 'msg', peerId: 'p', messageId: 'm1', ts: 10 });
  box.removeSent(sending);
  const snap = box.snapshot();
  assert.equal(snap.some((item) => item.messageId === 'm1' && item.ts === 10), true);
  assert.equal(snap.some((item) => item.messageId === 'm2'), true);
  assert.equal(snap.some((item) => item.messageId === 'm3'), true);
  assert.equal(snap.some((item) => item.messageId === 'm1' && item.ts === 1), false);
});

test('removeSentFromOutbox vergleicht logicalKey und ts', () => {
  const box = [
    { type: 'store-entry', key: 'contacts', id: 'x', ts: 1 },
    { type: 'store-entry', key: 'contacts', id: 'x', ts: 2 },
  ];
  const next = removeSentFromOutbox(box, [{ type: 'store-entry', key: 'contacts', id: 'x', ts: 1 }]);
  assert.equal(next.length, 1);
  assert.equal(next[0].ts, 2);
});

test('groups nutzen id, Fallback groupId; Maps mischen per Schlüssel', () => {
  const groups = diffStoreEntries('groups', [{ id: 'group:a', name: 'A' }], {});
  assert.equal(groups[0].id, 'group:a');
  const byGroupId = entriesOfStore('groups', [{ groupId: 'group:b', name: 'B' }]);
  assert.ok(byGroupId['group:b']);
  let receipts = { p1: 10 };
  receipts = applyStoreEntryToValue('chatReadReceipts', receipts, 'p2', { value: 20 });
  receipts = applyStoreEntryToValue('chatReadReceipts', receipts, 'p1', { deleted: true });
  assert.deepEqual(receipts, { p2: 20 });
});

test('gerätelokales Settings-Feld wird beim Apply ignoriert', () => {
  const current = { displayName: 'Ada', launchAtLogin: false };
  const next = applyStoreEntryToValue('settings', current, 'launchAtLogin', { value: true });
  assert.equal(next.launchAtLogin, false);
  const theme = applyStoreEntryToValue('settings', current, 'theme', { value: 'light' });
  assert.equal(theme.theme, 'light');
  assert.equal(theme.launchAtLogin, false);
});

test('remote contact stub keeps local name, picture and bio', () => {
  const local = [{ id: 'bt2_a', name: 'Ada', profilePicture: 'data:image/png;base64,abc', bio: 'hi' }];
  const next = applyStoreEntryToValue('contacts', local, 'bt2_a', {
    value: { id: 'bt2_a', features: ['message-edit'] },
  });
  assert.deepEqual(next[0], {
    id: 'bt2_a',
    features: ['message-edit'],
    name: 'Ada',
    profilePicture: 'data:image/png;base64,abc',
    bio: 'hi',
  });
  const renamed = applyStoreEntryToValue('contacts', local, 'bt2_a', {
    value: { id: 'bt2_a', name: 'Ada L.', profilePicture: 'data:image/png;base64,new' },
  });
  assert.equal(renamed[0].name, 'Ada L.');
  assert.equal(renamed[0].profilePicture, 'data:image/png;base64,new');
  const placeholder = applyStoreEntryToValue('contacts', local, 'bt2_a', {
    value: { id: 'bt2_a', name: 'bt2_a' },
  });
  assert.equal(placeholder[0].name, 'Ada');
});
