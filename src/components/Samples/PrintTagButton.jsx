// src/components/Samples/PrintTagButton.jsx
import { Printer } from 'lucide-react';
import { useState } from 'react';
import { printTags } from '../../utils/tags/browserPrint';
import { DEFAULT_PRINT_OPTIONS } from '../../utils/tags/printConfig';
import { useMessage } from '../Messages/MessageContext';

/**
 * Print one or many sample tags via Zebra Browser Print.
 * Pass `rows` (export-view row[s]) — single object or array.
 */
export default function PrintTagButton({ rows, label = 'Print tag', className, options }) {
  const { showMessage } = useMessage();
  const [busy, setBusy] = useState(false);

  const onClick = async (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    const list = Array.isArray(rows) ? rows : rows ? [rows] : [];
    if (list.length === 0) { showMessage('Nothing to print'); return; }
    setBusy(true);
    try {
      await printTags(list, { ...DEFAULT_PRINT_OPTIONS, ...(options || {}) });
      showMessage(list.length === 1 ? 'Tag sent to printer' : `${list.length} tags sent to printer`);
    } catch (err) {
      showMessage(err && err.message ? err.message : 'Print failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={className || 'px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-lg hover:bg-opacity-90 inline-flex items-center disabled:opacity-60'}
    >
      <Printer className="w-4 h-4 mr-2" />
      {busy ? 'Printing…' : label}
    </button>
  );
}
