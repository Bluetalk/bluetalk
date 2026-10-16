export function buildMessageNotificationPreview(message) {
  if (!message || typeof message !== 'object') return 'Neue Nachricht';
  if (message.kind === 'call-log') {
    if (message.outcome === 'missed') return 'Verpasster Anruf';
    return 'Sprachanruf';
  }
  if (message.kind === 'file' && message.voice) {
    const ms = Number(message.voice.durationMs) || 0;
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `🎤 Sprachnachricht (${m}:${String(s).padStart(2, '0')})`;
  }
  if (message.kind === 'file' || message.kind === 'file-link') {
    return `Datei: ${message.fileName || message.content || 'Anhang'}`;
  }
  if (message.kind === 'sticker') return 'Sticker';
  if (message.kind === 'poker-invite') return `Poker: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'uno-invite') return `UNO: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'connect-four-invite') return `Vier gewinnt: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'chess-invite') return `Schach: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'tic-tac-toe-invite') return `Tic-Tac-Toe: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'kart-invite') return `BlueKart: ${message.tableName || 'Einladung'}`;
  if (message.kind === 'contact-share') {
    return `Kontakt: ${message.sharedContact?.displayName || message.sharedContact?.name || 'geteilt'}`;
  }
  const content = String(message.content || '').trim();
  if (!content) return 'Neue Nachricht';
  return content.length > 240 ? `${content.slice(0, 237)}…` : content;
}
