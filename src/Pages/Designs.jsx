import { Plus, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import DesignList from "../components/Designs/DesignList";
import AddDesignModal from "../components/Designs/AddDesignModal";
import Loading from "../components/Loading";
import DesignInfoModal from "../components/Designs/DesignInfoModal";
import { useSupabase } from "../components/SupaBaseProvider";
import ImportModal from "../components/Products/ImportModal";
import { useLocation } from "react-router-dom";
import SearchBar from "../components/SearchBar";
import FilterButton from "../components/Filters/FilterButton";
import { getImages } from "../components/SupaBaseProvider";
import Pagination from "../components/MiscComponenets/Pagination";

const Designs = () => {
  const { supabase } = useSupabase();

  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [selectedDesign, setSelectedDesign] = useState(null);
  const [design, setDesign] = useState(null);
  const [designToShow, setDesignToShow] = useState(null);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const [designs, setDesigns] = useState([]);
  const [filteredItems, setFilteredItems] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [totalPages, setTotalPages] = useState(null);

  // const [isLoading, setIsLoading] = useState(true);
  const location = useLocation(); // Access the current URL
  const queryParams = new URLSearchParams(location.search); // Parse the query string
  const designId = queryParams.get("designId") || null;
  useEffect(() => {
    if (designId && !design) {
      // Only fetch if designId exists and design is not already set
      handleClick({ id: designId });
    }
  }, [designId, design]);

  // 
  const handleClick = async (design) => {
    // Open the modal immediately
    setIsDetailsOpen(true);

    // Show a loading state in the modal
    setDesign(null);

    // Fetch the design data
    const { data, error } = await supabase
      .from("designs")
      .select("*")
      .single()
      .eq("id", design.id);

    if (error) {
      console.error("Error fetching design:", error);
      setIsDetailsOpen(false); // Close the modal if there's an error
      return;
    }
    const {images,cad} = await getImages("design", design.id);
    console.log(images,cad,'images and cad for designs')
    // Update the design data in the modal
    setDesign({
      ...data,
      images,
      cad
    });
  };
  
  const updateDesign = (updatedDesigns) => {
    setDesigns((previousDesign) =>
      previousDesign.map((design) =>
        design.id === updatedDesigns.id ? updatedDesigns : design
      )
    );
  };

  // if(isLoading){
  //     return <Loading />
  // }
  // useEffect(()=>{
  //     console.log(isLoading,'is loading')
  // },[isLoading])

  return (
    <div className="p-4 ">
      <div className="flex justify-between items-center mb-6">
        <div className="flex flex-col">
          <h1 className="text-2xl font-bold text-gray-900">Designs</h1>
          <div className="flex gap-2">
            <SearchBar
              items={designs}
              type={"designs"}
              onSearch={(filteredItems) => {
                setFilteredItems(filteredItems);
              }}
              setIsLoading={setIsLoading}
              isLoading={isLoading}
            />
            <FilterButton type={"designs"} />
          </div>
        </div>
        <div className="flex space-x-3">
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
            New Design
          </button>
        </div>
      </div>
            <Pagination loading={isLoading} hasMore={hasMore} totalPages={totalPages}>
      <div className="flex-grow px-4 pb-4">

      <DesignList
        designs={filteredItems}
        setDesigns={setDesigns}
        setIsLoading={setIsLoading}
          setHasMore={setHasMore}
          setTotalPages={setTotalPages}
          hasMore={hasMore}
          isLoading={isLoading}
        onDesignClick={handleClick}
      />
          </div>         

            </Pagination>
      

      <AddDesignModal
        isOpen={isAddModalOpen}
        onSave={(design) => {
          setIsAddModalOpen(false);
          setDesigns((prev) => [design, ...prev]);
        }}
        onClose={() => setIsAddModalOpen(false)}
      />
      {design && (
        <DesignInfoModal
          isOpen={isDetailsOpen}
          onClose={() => setIsDetailsOpen(false)}
          design={design}
          updateDesign={updateDesign}
        />
      )}
      <ImportModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImport={(importedSamples) => {
          setDesigns((prev) => {
            // Create a map of existing samples for quick lookup
            const existingSamplesMap = new Map(
              prev.map((sample) => [sample.id, sample])
            );

            // Merge or add imported samples
            importedSamples.forEach((importedSample) => {
              if (existingSamplesMap.has(importedSample.id)) {
                // Update the existing sample
                existingSamplesMap.set(importedSample.id, importedSample);
              } else {
                // Add the new sample
                existingSamplesMap.set(importedSample.id, importedSample);
              }
            });

            // Return the updated list of samples
            return Array.from(existingSamplesMap.values());
          });
        }}
        type="designs"
      />
    </div>
  );
};
export default Designs;
