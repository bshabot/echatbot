import React, { useState, useEffect, useRef } from "react";
import { CornerDownLeft, Download } from "lucide-react";
import { exportData } from "../../utils/exportUtils";
import SampleCard from "../Samples/SampleCard";
import { useSupabase } from "../SupaBaseProvider";
import ViewableListActionButtons from "../MiscComponenets/ViewableListActionButtons";
import { useMessage } from "../Messages/MessageContext";
import { useGenericStore } from "../../store/VendorStore";
import { useSearchParams, useNavigate } from "react-router-dom"; // Import React Router hooks
import Loading from "../Loading";
import { Printer } from "lucide-react";
import { printTags, printResultMessage } from "../../utils/tags/browserPrint";
import { DEFAULT_PRINT_OPTIONS } from "../../utils/tags/printConfig";

export default function SampleList({ samples, setSamples, isLoading, setIsLoading, hasMore, setHasMore, setTotalPages, setResultCount, onSampleClick, onDuplicate, onDeleteSample }) {
  const { getEntity } = useGenericStore();
  const { options } = getEntity("settings");
  const [selectedSamples, setSelectedSamples] = useState(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  // const [page, setPage] = useState(0);
  // const [isloading, setIsLoading] = useState(false);
  // const [hasMore, setHasMore] = useState(true);
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const PAGE_SIZE = 60;

  const [searchParams, setSearchParams] = useSearchParams(); // React Router hook for query params
  const page = parseInt(searchParams.get("page") || "0", 10);
  const collection = searchParams.getAll('collection') || "";
  const category = searchParams.getAll('category') || "";
  const metals = searchParams.getAll('metal') || "";
  const chains = searchParams.getAll('chain') || "";
  const q = (searchParams.get('q') || "").trim();
  const vendor = searchParams.get('vendor') || "";
  const karat = searchParams.get('karat') || "";
  const backType = searchParams.get('back') || "";
  const stoneType = searchParams.get('stone') || "";
  const stoneColor = searchParams.get('stonecolor') || "";
  const sort = searchParams.get('sort') || "newest";

  // Fetch samples from Supabase — all filters combine server-side
  const fetchSamples = async (pageNumber) => {
    setIsLoading(true);
    const from = pageNumber * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    let query = supabase
      .from("sample_with_stones_export")
      .select('*', { count: "exact" }) // exact count so the pager knows the last page
      .range(from, to);

    // sort
    if (sort === "style") query = query.order("styleNumber", { ascending: true });
    else if (sort === "cost_desc") query = query.order("totalCost", { ascending: false, nullsFirst: false });
    else if (sort === "cost_asc") query = query.order("totalCost", { ascending: true, nullsFirst: false });
    else if (sort === "weight_desc") query = query.order("weight", { ascending: false, nullsFirst: false });
    else query = query.order("created_at", { ascending: false });

    // text search across the fields people actually remember
    if (q) {
      const safe = q.replace(/[,()]/g, " ").trim();
      query = query.or(
        `styleNumber.ilike.%${safe}%,name.ilike.%${safe}%,manufacturerCode.ilike.%${safe}%,starting_description.ilike.%${safe}%`
      );
    }

    if (collection.length > 0) query = query.in("sample_collection", collection);
    if (category.length > 0) query = query.in("sample_category", category);
    if (metals.length > 0) query = query.in("metalType", metals);
    if (chains.length > 0) query = query.in("necklace", chains);
    if (vendor) query = query.eq("vendor", vendor);
    if (karat) query = query.eq("karat", karat);
    if (backType) query = query.eq("back_type", backType);
    if (stoneType) query = query.contains("stones", [{ type: stoneType }]);
    if (stoneColor) query = query.contains("stones", [{ color: stoneColor }]);

    const { data, error, count } = await query;

    if (error) {
      console.error("Error fetching samples:", error);
      setIsLoading(false);
      return;
    }

    setSamples(data); // Replace samples with the current page's data
    setHasMore(data.length === PAGE_SIZE); // Check if there are more pages
    if (setTotalPages && count != null) setTotalPages(Math.max(1, Math.ceil(count / PAGE_SIZE)));
    if (setResultCount) setResultCount(count ?? null);
    setIsLoading(false);
  };
useEffect(()=>{
  console.log(selectedSamples,selectedSamples.size)
},[selectedSamples])
  // Fetch the first page on component mount
  // useEffect(() => {
  //   fetchSamples(0);
  // }, []);
  useEffect(() => {
    fetchSamples(page); // Fetch samples whenever the page or any filter changes
  }, [page, searchParams]);

  // Handle page navigation


  const getDataToExport = async (arrayOfProducts) => {
    console.log(arrayOfProducts)
    try {
      // Fetch samples and their starting_info
      const { data: samplesData, error: sampleDataError } = await supabase
        .from("sample_with_stones_export")
        .select("*")
        .in(
          "sample_id",
          arrayOfProducts
        );

      if (sampleDataError) {
        console.error("Error fetching samples:", sampleDataError);
        return [];
      }
      console.log(samplesData)
      return samplesData; // Return samples with their stones
    } catch (error) {
      console.error("Error in getDataToExport:", error);
      throw new Error(error)
      // return [];
    }
  };

  const fetchAllRows = async () => {
  let allRows = [];
  let batchSize = 1000;
  let start = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('sample_with_stones_export')
      .select('*')
      .range(start, start + batchSize - 1);

    if (error) {
      console.error('Error fetching data:', error);
      break;
    }

    allRows = allRows.concat(data);
    hasMore = data.length === batchSize;
    start += batchSize;
  }

  return allRows;
};
  const getDropDownData = async () => {
    const { data, error } = await supabase.rpc("get_dropdown_options");

    if (error) {
      showMessage("Issue with retriving dropdown options");
    }
    return data;
  };
  const handleExport = async (type='') => {
    // const samplesToExport = samples.filter((p) => selectedSamples.has(p.sample_id));
    const samplesToExport = Array.from(selectedSamples)

    console.log(samplesToExport,samplesToExport.length)
    // let dataToExport = await fetchAllRows()
    let dataToExport =type==='all'? await fetchAllRows() : await getDataToExport(samplesToExport);
    let dropdowns = await getDropDownData();
    dropdowns = {
      ...dropdowns,
      color: options?.stonePropertiesForm?.color.map((option) => ({ name: option })),
      type: options?.stonePropertiesForm?.type.map((option) => ({ name: option })),
      backType: options?.formFields?.backType.map((option) => ({ name: option })),
    };

    exportData(dataToExport, dropdowns, "samples");
    setSelectedSamples(new Set());
    setIsSelectionMode(false);
  }; 
   

   const toggleSampleSelection = (sample) => {
    const newSelection = new Set(selectedSamples);
    if (newSelection.has(sample.sample_id)) {
      console.log('already selected', sample.sample_id);
      newSelection.delete(sample.sample_id);
    } else {
      console.log('not selected, adding', sample.sample_id);
      newSelection.add(sample.sample_id);
    }
    setSelectedSamples(newSelection);
  };
  
  const [isPrinting, setIsPrinting] = useState(false);

  // Single tag - the card row is already a sample_with_stones_export row.
  const handlePrintOne = async (sample) => {
    try {
      const mode = await printTags([sample], DEFAULT_PRINT_OPTIONS);
      showMessage(printResultMessage(mode, 1));
    } catch (err) {
      showMessage(err && err.message ? err.message : "Print failed");
    }
  };

  // Batch - fetch full rows for the selected ids (handles selections across pages).
  const handlePrintSelected = async () => {
    const ids = Array.from(selectedSamples);
    if (ids.length === 0) return;
    setIsPrinting(true);
    try {
      const rows = await getDataToExport(ids);
      if (!rows || rows.length === 0) { showMessage("Nothing to print"); return; }
      const mode = await printTags(rows, DEFAULT_PRINT_OPTIONS);
      showMessage(printResultMessage(mode, rows.length));
    } catch (err) {
      showMessage(err && err.message ? err.message : "Print failed");
    } finally {
      setIsPrinting(false);
    }
  };

  if(isLoading){
    return <Loading />

  }
  return (
    <div>
      {/* Sticky just under the page header bar so Select/Export/Print stay
          reachable while scrolling */}
      <div className="sticky sample-list-action-bar z-20 bg-gray-100">
      <ViewableListActionButtons
        isSelectionMode={isSelectionMode}
        setIsSelectionMode={setIsSelectionMode}
        handleSelections={(selected) => setSelectedSamples(selected)}
        handleExport={handleExport}
        handleExportAll={() => handleExport('all')}
        onDelete={(deletedSelectedItems) =>
          setSamples(samples.filter((s) => !deletedSelectedItems.includes(s.id)))
        }
        allItems={samples.map((s) => s.sample_id)}
        selectedItems={selectedSamples}
        type="Samples"
        extraSelectedActions={
          <button
            onClick={handlePrintSelected}
            disabled={isPrinting}
            className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-lg hover:bg-opacity-90 inline-flex items-center disabled:opacity-60"
          >
            <Printer className="w-4 h-4 mr-2" />
            {isPrinting ? "Printing\u2026" : `Print Tags (${selectedSamples.size})`}
          </button>
        }
      />
      </div>

      <div className="flex flex-col">
        <div className="h-full grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
          {samples.map((sample) => 
          
          {
            // console.log(selectedSamples,'selected samples')
            // console.log([...selectedSamples].some(s=> s.sample_id === sample.sample_id),sample.sample_id,'selected')

            return <SampleCard
            key={sample.sample_id}
            sample={sample}
            onClick={isSelectionMode ? toggleSampleSelection : onSampleClick}
            selected={selectedSamples.has(sample.sample_id)}
            selectable={isSelectionMode} onDuplicate={onDuplicate}
 onDelete={onDeleteSample}
            onPrintTag={handlePrintOne}
            />
          }
          )}
        </div>
        
        
      </div>
    </div>
  );
};

