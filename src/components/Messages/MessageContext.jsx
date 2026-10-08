import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const MessageContext = createContext();

export const useMessage = () => useContext(MessageContext);

// ---------------------------------------------------------------------------
// App-wide toasts.
//
//   const { showMessage } = useMessage();
//   showMessage("Saved");                                   // type is guessed
//   showMessage("Could not save", { type: "error" });       // explicit
//   showMessage("Deleted 3 samples", {
//     action: { label: "Undo", onClick: () => restore() },  // keeps it up longer
//   });
//
// Existing showMessage("text") calls keep working unchanged: the type
// (success / error / info) is guessed from the wording, toasts stack instead
// of overwriting each other, and each one has its own timer + a dismiss button.
// ---------------------------------------------------------------------------

const ERROR_RE = /\b(error|errored|fail(ed|ure|s)?|could not|couldn'?t|can'?t|cannot|unable|denied|invalid|issue|problem|required|missing|please (fill|select|enter|choose)|not found|already exists?)\b/i;
const SUCCESS_RE = /\b(saved|success(fully)?|created|updated|deleted|removed|added|copied|restored|imported|sent|done|complete(d)?|synced|approved)\b/i;

function guessType(text) {
  if (ERROR_RE.test(text)) return 'error';
  if (SUCCESS_RE.test(text)) return 'success';
  return 'info';
}

function toText(msg) {
  if (msg == null) return '';
  if (typeof msg === 'string') return msg;
  if (typeof msg === 'number') return String(msg);
  if (msg instanceof Error) return msg.message;
  if (typeof msg.message === 'string') return msg.message;
  return String(msg);
}

const MAX_TOASTS = 4;

export const MessageProvider = ({ children }) => {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const nextId = useRef(1);

  const dismiss = useCallback((id) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setToasts((list) => list.filter((x) => x.id !== id));
  }, []);

  const showMessage = useCallback(
    (msg, optsIn = {}) => {
      // Older call sites pass the type as a bare string: showMessage("Saved", "success")
      const opts = typeof optsIn === 'string' ? { type: optsIn } : optsIn || {};
      const text = toText(msg);
      if (!text) return null;
      const type = opts.type || guessType(text);
      // Errors and anything with an action (e.g. Undo) stay up longer.
      const duration =
        opts.duration ?? (opts.action ? 8000 : type === 'error' ? 6000 : 3500);
      const id = nextId.current++;
      setToasts((list) => {
        // The same text twice in a row just refreshes instead of stacking.
        const rest = list.filter((x) => x.text !== text);
        return [...rest, { id, text, type, action: opts.action || null }].slice(-MAX_TOASTS);
      });
      if (duration > 0) timers.current.set(id, setTimeout(() => dismiss(id), duration));
      return id;
    },
    [dismiss]
  );

  // `message` (latest toast text) is kept so any older consumer still works.
  const value = useMemo(
    () => ({
      message: toasts.length ? toasts[toasts.length - 1].text : '',
      toasts,
      showMessage,
      dismissMessage: dismiss,
    }),
    [toasts, showMessage, dismiss]
  );

  return <MessageContext.Provider value={value}>{children}</MessageContext.Provider>;
};
