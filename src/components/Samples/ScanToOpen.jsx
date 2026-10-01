// src/components/Samples/ScanToOpen.jsx
import { useSupabase } from '../SupaBaseProvider';
import { useNavigate } from 'react-router-dom';
import { findSampleByStyleNumber } from '../../utils/tags/tagData';
import { findSetByStyleNumber } from '../../utils/sampleSets';
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
        if (row) {
          navigate(`/samples?sampleId=${encodeURIComponent(row.sample_id)}`);
          return;
        }
        // Not a sample style number -- it may be a SET tag (the set's own style).
        const set = await findSetByStyleNumber(supabase, code);
        if (set?.firstSampleId != null) {
          showMessage(`Set "${set.style_number}" -- opening item 1`);
          navigate(`/samples?sampleId=${encodeURIComponent(set.firstSampleId)}`);
        } else {
          showMessage(`No sample found for "${code}"`);
        }
      } catch (err) {
        showMessage(err && err.message ? err.message : 'Scan lookup failed');
      }
    },
    { minLength, enabled, gapMs }
  );

  return null;
}
