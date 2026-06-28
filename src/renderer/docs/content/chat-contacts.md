# Chat & Contacts

## Chat pipeline

Use `api.chat.send` in the renderer to send messages through BlueTalk's encrypted chat pipeline. Messages are persisted and appear in the chat UI.

```javascript
api.chat.send(peerId, {
  kind: 'my-plugin-invite',
  sessionId: 'abc123',
  title: 'Join my session',
});
```

Chat payloads can be any JSON object with a `kind` field. The app handles E2EE encryption automatically for direct chats.

### Delete messages

```javascript
api.chat.delete(peerId, messageId)
api.chat.deleteChat(peerId)
```

## Contacts

### Renderer API (recommended)

```javascript
const contacts = api.contactsApi.list();
api.contactsApi.update({ id: peerId, nickname: 'Alice' });
api.contactsApi.setBlocked(peerId, true);
api.contactsApi.setPinned(peerId, true);
```

### Main process API

Direct store access (same data, no E2EE involvement):

```javascript
api.contacts.list()
api.contacts.update({ id, nickname, blocked, ... })
```

## Composer attachments

Register a custom option in the chat composer "+" menu:

```javascript
api.ui.registerComposerAttachment({
  id: 'share-doc',
  label: 'Share document',
  icon: 'FileText',
  order: 100,
  onSelect(ctx) {
    const { peerId, closeMenu, sendMessage, toast } = ctx;
    sendMessage(peerId, { kind: 'doc-invite', docId: 'abc' });
    closeMenu();
    toast({ variant: 'success', title: 'Invite sent' });
  },
});
```

The `onSelect` context provides:

| Field | Description |
|-------|-------------|
| `peerId` | Active chat peer |
| `closeMenu` | Close the attach menu |
| `sendMessage` | Send via chat pipeline |
| `toast` | Show in-app toast |
| `settings` | App settings snapshot |
| `contacts` | Contacts list |
| `peers` | Connected peers |

## Invitations pattern

Game and realtime plugins typically:

1. Send a chat invite with metadata (`kind: 'my-plugin-invite'`)
2. Broadcast presence for public discovery (`api.realtime` or manual `peer.broadcast`)
3. Handle join on the host side when peer connects
