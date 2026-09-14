import { useEffect, useState } from "react";
import { useSupabase } from "../SupaBaseProvider";

// samples.location is free text ("Tray 12", "Tray 12 / slot B", "Ezra's desk")
// so there is no settings-managed list to read. The distinct values already in
// use come from the sample_locations view, and they drive two things:
//   - the datalist below, so typing in a sample modal autocompletes to a tray
//     that already exists instead of inventing "tray 12" next to "Tray 12"
//   - the Location dropdown in SampleFilterBar
// The view is tiny (one short text column, distinct), so a plain fetch on mount
// is fine — no need to push it into the settings store.
export function useSampleLocations() {
  const { supabase } = useSupabase();
  const [locations, setLocations] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("sample_locations")
        .select("location");
      if (error) {
        console.error("Error fetching sample locations:", error);
        return;
      }
      if (!cancelled) {
        setLocations((data || []).map((r) => r.location).filter(Boolean));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  return locations;
}

// Shared <datalist> for the Location inputs. Rendered inside each modal; the
// id is what the inputs point at with list="sample-location-options".
export default function SampleLocationOptions() {
  const locations = useSampleLocations();
  return (
    <datalist id="sample-location-options">
      {locations.map((loc) => (
        <option key={loc} value={loc} />
      ))}
    </datalist>
  );
}
