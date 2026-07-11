import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MAX_CHAT_FILE_SIZE_BYTES,
  MAX_CHAT_FILE_SIZE_MB,
  readFileAsBase64WithProgress,
} from '../messageHelpers.jsx';
import { normalizeAttachmentFileType } from '../../../utils/attachmentImage';

/**
 * Datei-Anhang-Zustand des Composers: pendingFile (inkl. ObjectURL-Cleanup),
 * Lese-/Sende-Fortschritt und das Einreihen einer Datei mit Fortschritt.
 * Lebt bewusst auf Seiten-Ebene, weil z. B. das Löschen eines Chats den
 * Anhang verwirft (setPendingFile(null)) — exakt wie zuvor.
 * 1:1 aus Chats.jsx extrahiert — Verhalten unverändert.
 */
export function useAttachments({ toast, setWarning }) {
  const [pendingFile, setPendingFile] = useState(null);
  /** null | { stage: 'reading' | 'sending', percent: number, detail: string } */
  const [fileTransfer, setFileTransfer] = useState(null);

  const pendingFileRef = useRef(null);
  useEffect(() => {
    pendingFileRef.current = pendingFile;
  }, [pendingFile]);

  useEffect(() => () => {
    const p = pendingFileRef.current;
    if (p?.objectUrl) {
      try {
        URL.revokeObjectURL(p.objectUrl);
      } catch {
        /* ignore */
      }
    }
  }, []);

  const clearPendingFile = useCallback(() => {
    setPendingFile((prev) => {
      if (prev?.objectUrl) {
        try {
          URL.revokeObjectURL(prev.objectUrl);
        } catch {
          /* ignore */
        }
      }
      return null;
    });
  }, []);

  const queuePendingFile = useCallback(async (file) => {
    if (!file) return;

    if (file.size > MAX_CHAT_FILE_SIZE_BYTES) {
      const msg = `Max file size in chat is ${MAX_CHAT_FILE_SIZE_MB} MB.`;
      setWarning(msg);
      toast({ variant: 'warning', title: 'File too large', message: msg });
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setFileTransfer({ stage: 'reading', percent: 0, detail: 'Reading file…' });
    setWarning('');
    try {
      const data = await readFileAsBase64WithProgress(
        file,
        (p) => {
          setFileTransfer({
            stage: 'reading',
            percent: Math.min(100, Math.round(p * 100)),
            detail: 'Reading file…',
          });
        },
        true
      );
      setPendingFile((prev) => {
        if (prev?.objectUrl) {
          try {
            URL.revokeObjectURL(prev.objectUrl);
          } catch {
            /* ignore */
          }
        }
        return {
          name: file.name,
          size: file.size,
          type: normalizeAttachmentFileType(file.name, file.type || 'application/octet-stream', data.base64),
          objectUrl,
          base64: data.base64,
        };
      });
    } catch {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        /* ignore */
      }
      const msg = 'Could not read file.';
      setWarning(msg);
      toast({ variant: 'error', title: 'File error', message: msg });
    } finally {
      setFileTransfer(null);
    }
  }, [setWarning, toast]);

  const readingFile = fileTransfer?.stage === 'reading';
  const sendingFile = fileTransfer?.stage === 'sending';

  return {
    pendingFile,
    setPendingFile,
    clearPendingFile,
    queuePendingFile,
    fileTransfer,
    setFileTransfer,
    readingFile,
    sendingFile,
  };
}
