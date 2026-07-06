// src/components/Samples/ScanToOpen.jsx
import { useSupabase } from '../SupaBaseProvider';
import { useNavigate } from 'react-router-dom';
import { findSampleByStyleNumber } from '../../utils/tags/tagData';
import { useMessage } from '../Messages/MessageContext';
import useScanListener from '../../Hooks/useScanListener';

/**
 * Scan-to-open: scanning a tag QR (the style number) looks the sample up and
 * opens it. Renders nothing. Mount inside the authenticated area (e.g. the
 * Samples page). The buffering lives in useScanListener (shared with the
 * quote scan-to-add).
 */
export default function ScanToOpen({ minLength = 3, enabled = true, gapMs = 100 }) {
  const { supabase } = useSupabase();
  const navigate = useNavigate();
  const { showMessage } = useMessage();

  useScanListener(
    async (code) => {
      try {
        const row = await findSampleByStyleNumber(supabase, code);
        if (row) navigate(`/samples?sampleId=${encodeURIComponent(row.sample_id)}`);
        else showMessage(`No sample found for "${code}"`);
      } catch (err) {
        showMessage(err && err.message ? err.message : 'Scan lookup failed');
      }
    },
    { minLength, enabled, gapMs }
  );

  return null;
}
