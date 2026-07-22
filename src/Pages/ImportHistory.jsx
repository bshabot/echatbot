// src/Pages/ImportHistory.jsx
import { useEffect, useState } from 'react';
import { Printer, RefreshCw } from 'lucide-react';
import { useSupabase } from '../components/SupaBaseProvider';
import { useMessage } from '../components/Messages/MessageContext';
import { listImportBatches, fetchTagRowsBySampleIds } from '../utils/tags/tagData';
import { printTags, printResultMessage } from '../utils/tags/browserPrint';
import { DEFAULT_PRINT_OPTIONS } from '../utils/tags/printConfig';
import { formatShortDate } from '../utils/dateUtils';
import Loading from '../components/Loading';

const TYPES = ['all', 'samples', 'designs', 'products'];

export default function ImportHistory() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const [batches, setBatches] = useState([]);
  const [type, setType] = useState('all');
  const [loading, setLoading] = useState(false);
  const [printingId, setPrintingId] = useState(null);

  const load = async (t = type) => {
    setLoading(true);
    try {
      setBatches(await listImportBatches(supabase, { type: t }));
    } catch (err) {
      showMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(type); /* eslint-disable-next-line */ }, [type]);

  const printBatch = async (batch) => {
    setPrintingId(batch.id);
    try {
      const rows = await fetchTagRowsBySampleIds(supabase, batch.sample_ids || []);
      if (rows.length === 0) { showMessage('No samples from this batch still exist'); return; }
      const mode = await printTags(rows, DEFAULT_PRINT_OPTIONS);
      const missing = (batch.sample_ids || []).length - rows.length;
      showMessage(printResultMessage(mode, rows.length) + (missing > 0 ? ` (${missing} no longer exist)` : ''));
    } catch (err) {
      showMessage(err && err.message ? err.message : 'Print failed');
    } finally {
      setPrintingId(null);
    }
  };

  return (
    <div className="p-4">
      <div className="flex flex-wrap justify-between items-center mb-6 gap-2">
        <h1 className="text-2xl font-bold text-gray-900">Import History</h1>
        <div className="flex items-center gap-2">
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white"
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>{t === 'all' ? 'All types' : t}</option>
            ))}
          </select>
          <button
            onClick={() => load(type)}
            className="px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white hover:bg-gray-50 inline-flex items-center"
          >
            <RefreshCw className="w-4 h-4 mr-2" /> Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <Loading />
      ) : batches.length === 0 ? (
        <p className="text-gray-500">No imports logged yet.</p>
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="w-full min-w-max text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-4 py-2 font-medium">When</th>
                <th className="text-left px-4 py-2 font-medium">Type</th>
                <th className="text-left px-4 py-2 font-medium">File</th>
                <th className="text-left px-4 py-2 font-medium">Count</th>
                <th className="text-left px-4 py-2 font-medium">By</th>
                <th className="text-right px-4 py-2 font-medium">Labels</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id} className="border-t border-gray-100">
                  <td className="px-4 py-2">{formatShortDate(b.created_at)}</td>
                  <td className="px-4 py-2 capitalize">{b.type}</td>
                  <td className="px-4 py-2 text-gray-600">{b.source_filename || '—'}</td>
                  <td className="px-4 py-2">{b.sample_count}</td>
                  <td className="px-4 py-2 text-gray-600">{b.created_by || '—'}</td>
                  <td className="px-4 py-2 text-right">
                    {b.type === 'samples' && b.sample_count > 0 ? (
                      <button
                        onClick={() => printBatch(b)}
                        disabled={printingId === b.id}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-chabot-gold rounded-md hover:bg-opacity-90 inline-flex items-center disabled:opacity-60"
                      >
                        <Printer className="w-3.5 h-3.5 mr-1.5" />
                        {printingId === b.id ? 'Printing…' : 'Print labels'}
                      </button>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
