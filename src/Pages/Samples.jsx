import { Plus, Upload, Printer, X } from "lucide-react";
import { useEffect, useState } from "react";
import Loading from "../components/Loading";
import { getImages, useSupabase } from "../components/SupaBaseProvider";
import SampleList from "../components/Samples/SampleList";
import { duplicateSample } from "../utils/duplicateSample";
import AddSampleModal from "../components/Samples/AddSampleModal";
import SampleInfoModal from "../components/Samples/SampleInfoModal";
import ImportModal from "../components/Products/ImportModal";
import { useLocation } from "react-router-dom";
import SearchBar from "../components/SearchBar";
import Pagination from "../components/MiscComponenets/Pagination";
import FilterButton from "../components/Filters/FilterButton";
import ScanToOpen from "../components/Samples/ScanToOpen";
import { printTags, printResultMessage } from "../utils/tags/browserPrint";
import { fetchTagRowsBySampleIds } from "../utils/tags/tagData";
import { DEFAULT_PRINT_OPTIONS } from "../utils/tags/printConfig";
import { useMessage } from "../components/Messages/MessageContext";
import { useAlert } from "../components/Alerts/AlertContext";

export default function Samples() {
  const { supabase } = useSupabase();
  const { showMessage } = useMessage();
  const { showAlert, showConfirm, showPrompt } = useAlert();
  const [lastImport, setLastImport] = useState(null);
  const [printingImport, setPrintingImport] = useState(false);

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [sample, setSample] = useState(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [samples, setSamples] = useState([]);
  const [filteredItems, setFilteredItems] = useState([]);
  const [hasMore, setHasMore] = useState(true);
  const [totalPages, setTotalPages] = useState(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const location = useLocation(); // Access the current URL
  const queryParams = new URLSearchParams(location.search); // Parse the query string
  const sampleId = queryParams.get("sampleId") || null;

  useEffect(() => {
    if (sampleId) {
      // handleClick expects `sample.sample_id`, not `sample.id` — pass the field name it actually reads.
      handleClick({ sample_id: sampleId });
    }
  }, [sampleId]);

  const handleClick = async (sample) => {
    // Open the modal immediately
    setIsDetailsOpen(true);

    // Show a loading state in the modal
    setSample(null);

    // Fetch the sample data
    const { data, error } = await supabase
      .from("samples")
      .select("*, starting_info(*)")
      .eq("id", sample.sample_id)
      .single();
 
    const { images, cad } = await getImages(
      "starting_info",
      data.starting_info?.id
    );
    console.log(images, cad);

    if (error) {
      console.error("Error fetching sample:", error);
      setIsDetailsOpen(false); // Close the modal if there's an error
      return;
    }

    const { data: stones, error: stonesError } = await supabase
      .from("stones")
      .select("*")
      .eq("starting_info_id", data.starting_info.id);

    if (stonesError) {
      console.error("Error fetching stones:", stonesError);
      setIsDetailsOpen(false); // Close the modal if there's an error
      return;
    }

    const startingInfo = data.starting_info;
    delete data.starting_info;

    const restructuredData = {
      formData: data,
      starting_info: {
        images: images,
        cad: cad,
        ...startingInfo,
        stones: stones,
      },
    };

    // Update the sample data in the modal
    setSample(restructuredData);
  };
  const updateSample = (updatedSamples) => {
    console.log(updatedSamples);
    setIsDetailsOpen(false);
    setSamples((previousSample) =>
      previousSample.map((Sample) =>
        Sample.sample_id === updatedSamples.id ? updatedSamples : Sample
      )
    );
  };

  // if(isLoading){
  //     return <Loading />
  // }

  const handleDelete = async (s) => {
    const styleNum = s.styleNumber || s.sample_style_number || s.sample_id;
    if (!(await showConfirm('Delete sample "' + styleNum + '"? This removes the sample, its starting_info, stones, and image links. This cannot be undone.', { confirmText: "Delete", variant: "error" }))) return;
    const sampleId = s.sample_id || s.id;
    const startingInfoId = s.starting_info_id;
    try {
      if (startingInfoId) {
        await supabase.from("image_link").delete().eq("entity", "starting_info").eq("entityId", startingInfoId);
        await supabase.from("stones").delete().eq("starting_info_id", startingInfoId);
      }
      await supabase.from("samples").delete().eq("id", sampleId);
      if (startingInfoId) {
        await supabase.from("starting_info").delete().eq("id", startingInfoId);
      }
      setSamples((prev) => prev.filter((x) => x.sample_id !== sampleId));
      setFilteredItems((prev) => prev.filter((x) => x.sample_id !== sampleId));
    } catch (err) {
      showAlert(String(err?.message || err), { title: "Error deleting sample", variant: "error" });
    }
  };

  const handlePrintImported = async () => {
    if (!lastImport || !lastImport.ids || lastImport.ids.length === 0) return;
    setPrintingImport(true);
    try {
      const rows = await fetchTagRowsBySampleIds(supabase, lastImport.ids);
      if (rows.length === 0) { showMessage("No imported samples to print"); return; }
      const mode = await printTags(rows, DEFAULT_PRINT_OPTIONS);
      showMessage(printResultMessage(mode, rows.length));
    } catch (err) {
      showMessage(err && err.message ? err.message : "Print failed");
    } finally {
      setPrintingImport(false);
    }
  };

  const handleDuplicate = async (s) => {
    const newSn = await showPrompt("Enter new style number for the duplicate:", {
      title: "Duplicate sample",
      confirmText: "Duplicate",
      placeholder: "e.g. N3042HE-GP",
      defaultValue: s.styleNumber || "",
    });
    if (!newSn || !newSn.trim()) return;
    try {
      await duplicateSample(supabase, s, newSn.trim());
      window.location.reload();
    } catch (err) {
      showAlert(err.message, { title: "Error duplicating sample", variant: "error" });
    }
  };

  return (
    <div className=" p-4 ">
      <ScanToOpen />
      {lastImport && lastImport.count > 0 && (
        <div className="mb-4 flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-4 py-2">
          <span className="text-sm text-amber-900">
            Imported {lastImport.count} sample{lastImport.count === 1 ? "" : "s"}.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handlePrintImported}
              disabled={printingImport}
              className="px-3 py-1.5 text-xs font-medium text-white bg-chabot-gold rounded-md hover:bg-opacity-90 inline-flex items-center disabled:opacity-60"
            >
              <Printer className="w-3.5 h-3.5 mr-1.5" />
              {printingImport ? "Printing\u2026" : `Print ${lastImport.count} tags`}
            </button>
            <button onClick={() => setLastImport(null)} className="p-2 text-amber-700 hover:text-amber-900 rounded-md" aria-label="Dismiss">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      {/* Sticky action bar — search / filter / import / new stay reachable
          while scrolling. z-20: above cards (z-10), below chrome (z-30). */}
      <div className="sticky top-0 z-20 -mx-4 mb-6 flex justify-between items-center bg-gray-100 px-4 py-3 border-b border-gray-200 max-md:flex-wrap max-md:gap-2 max-md:pb-2">
        <div className="flex flex-col max-md:w-full">
          <h1 className="text-2xl font-bold text-gray-900 max-md:text-xl">Samples</h1>
          <div className="flex gap-2">
            <SearchBar
              items={samples}
              type={"sample_with_stones_export"}
              onSearch={(filteredItems) => {
                setFilteredItems(filteredItems);
              }}
              setIsLoading={setIsLoading}
              isLoading={isLoading}
            />
            <FilterButton type={"samples"} />
          </div>
        </div>
        <div className="flex space-x-3 max-md:w-full max-md:justify-end">
          <button
            className="bg-white text-gray-700 px-4 py-2 rounded-lg flex items-center hover:bg-gray-50 border border-gray-300"
            onClick={() => setIsImportModalOpen(true)}
          >
            <Upload className="w-5 h-5 mr-2" />
            Import
          </button>
          <button
            className="bg-chabot-gold text-white px-4 py-2 rounded-lg flex items-center hover:bg-opacity-90 transition-colors"
            onClick={() => setIsAddModalOpen(true)}
          >
            <Plus className="w-5 h-5 mr-2" />
            New Sample
          </button>
        </div>
      </div>

      <Pagination loading={isLoading} hasMore={hasMore} totalPages={totalPages}>
        <div className="flex-grow px-4 pb-4">
          <SampleList
            onDuplicate={handleDuplicate}
            samples={filteredItems}
            onDeleteSample={handleDelete}
            setSamples={setSamples}
            setIsLoading={setIsLoading}
            setHasMore={setHasMore}
            setTotalPages={setTotalPages}
            hasMore={hasMore}
            isLoading={isLoading}
            onSampleClick={handleClick}
          />
        </div>
      </Pagination>
      <AddSampleModal
        isOpen={isAddModalOpen}
        onSave={(sample) => {
          setIsAddModalOpen(false);
          setSamples((prev) => [sample, ...prev]);
        }}
        onClose={() => {
          setIsAddModalOpen(false);
        }}
      />
      {sample && (
        <SampleInfoModal
          onDuplicate={handleDuplicate}
          isOpen={isDetailsOpen}
          sample={sample}
          onClose={() => setIsDetailsOpen(false)}
          updateSample={updateSample}
        />
      )}
      <ImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImport={(importedSamples) => {
          const importedIds = (importedSamples || []).map((s) => s.id).filter(Boolean);
          setLastImport({ ids: importedIds, count: importedIds.length });
          setSamples((prev) => {
            // Create a map of existing samples for quick lookup
            const existingSamplesMap = new Map(
              prev.map((sample) => [sample.sample_id, sample])
            );

            // Merge or add imported samples
            importedSamples.forEach((importedSample) => {
              if (existingSamplesMap.has(importedSample.sample_id)) {
                // Update the existing sample
                existingSamplesMap.set(
                  importedSample.sample_id,
                  importedSample
                );
              } else {
                // Add the new sample
                existingSamplesMap.set(
                  importedSample.sample_id,
                  importedSample
                );
              }
            });

            // Return the updated list of samples
            return Array.from(existingSamplesMap.values());
          });
        }}
        type="samples"
      />
    </div>
  );
}
