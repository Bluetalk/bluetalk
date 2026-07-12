export function buildMessageNotificationPreview(message) {
  if (!message || typeof message !== 'object') return 'Neue Nachricht';
  if (message.kind === 'file') {
    return `Datei: ${message.fileName || message.content || 'Anhang'}`;
  }
  if (message.kind === 'sticker') return 'Sticker';
  if (message.kind === 'poker-invite') return `Poker: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'uno-invite') return `UNO: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'connect-four-invite') return `Vier gewinnt: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'chess-invite') return `Schach: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'tic-tac-toe-invite') return `Tic-Tac-Toe: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'live-docs-invite') return `Dokument: ${message.fileName || message.tableName || 'Einladung'}`;
  if (message.kind === 'contact-share') {
    return `Kontakt: ${message.sharedContact?.displayName || message.sharedContact?.name || 'geteilt'}`;
  }
  const content = String(message.content || '').trim();
  if (!content) return 'Neue Nachricht';
  return content.length > 240 ? `${content.slice(0, 237)}…` : content;
}
