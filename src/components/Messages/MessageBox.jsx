import React from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';
import { useMessage } from '../Messages/MessageContext';

const STYLES = {
  success: { Icon: CheckCircle2, bar: 'border-l-green-500', icon: 'text-green-600' },
  error: { Icon: XCircle, bar: 'border-l-red-500', icon: 'text-red-600' },
  info: { Icon: Info, bar: 'border-l-[#C5A572]', icon: 'text-[#C5A572]' },
};

const MessageBox = () => {
  const { toasts, dismissMessage } = useMessage();

  if (!toasts.length) return null;

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 right-4 z-[80] flex flex-col gap-2 items-end w-[min(24rem,calc(100vw-2rem))] max-md:left-4 max-md:right-4 max-md:w-auto max-md:bottom-[max(1rem,env(safe-area-inset-bottom))]"
    >
      {toasts.map((t) => {
        const { Icon, bar, icon } = STYLES[t.type] || STYLES.info;
        return (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            className={`w-full flex items-start gap-3 bg-white text-gray-800 text-sm rounded-lg shadow-lg border border-gray-200 border-l-4 ${bar} px-3 py-2.5`}
          >
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${icon}`} />
            <span className="flex-1 break-words">{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action.onClick?.();
                  dismissMessage(t.id);
                }}
                className="shrink-0 font-semibold text-[#8a6d3b] hover:underline"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismissMessage(t.id)}
              aria-label="Dismiss"
              className="shrink-0 text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
};

export default MessageBox;
