// src/components/Samples/ScanToOpen.jsx
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSupabase } from '../SupaBaseProvider';
import { findSampleByStyleNumber } from '../../utils/tags/tagData';
import { useMessage } from '../Messages/MessageContext';

/**
 * Scan-to-open: a USB 2D barcode scanner in keyboard-wedge mode types the
 * scanned style number (the QR payload) followed by Enter. We buffer the fast
 * keystrokes and, on Enter, look the sample up by styleNumber and open it.
 *
 * Renders nothing. Mount inside the authenticated area (e.g. the Samples page).
 * No public route is added — the lookup runs through the logged-in client.
 */
export default function ScanToOpen({ minLength = 3, enabled = true, gapMs = 100 }) {
  const { supabase } = useSupabase();
  const navigate = useNavigate();
  const { showMessage } = useMessage();
  const buf = useRef('');
  const last = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = async (e) => {
      const el = e.target;
      const tag = (el && el.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
      const now = Date.now();
      if (now - last.current > gapMs) buf.current = ''; // human-speed gap => new entry
      last.current = now;
      if (e.key === 'Enter') {
        const code = buf.current.trim();
        buf.current = '';
        if (code.length < minLength) return;
        try {
          const row = await findSampleByStyleNumber(supabase, code);
          if (row) navigate(`/samples?sampleId=${encodeURIComponent(row.sample_id)}`);
          else showMessage(`No sample found for "${code}"`);
        } catch (err) {
          showMessage(err && err.message ? err.message : 'Scan lookup failed');
        }
      } else if (e.key && e.key.length === 1) {
        buf.current += e.key;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, gapMs, minLength, supabase, navigate, showMessage]);

  return null;
}
