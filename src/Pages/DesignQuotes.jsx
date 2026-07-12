import { Plus, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import DesignQuoteList from '../components/DesignQuotes/DesignQuoteList';
import AddDesignQuoteModal from '../components/DesignQuotes/AddDesignQuoteModal';
import Loading from '../components/Loading';
import DesignQuoteInfoModal from '../components/DesignQuotes/DesignQuoteInfoModal';
import DesignApprovalForm from '../components/DesignQuotes/DesignApprovalForm';
import { useSupabase } from '../components/SupaBaseProvider';
import { useLocation } from 'react-router-dom';
import ImportModal from '../components/Products/ImportModal';
import { getImages } from '../components/SupaBaseProvider';
const DesignQuote = () =>{
    const {supabase} = useSupabase();
    const location = useLocation(); // Access the current URL
    const queryParams = new URLSearchParams(location.search); // Parse the query string
    const designId = queryParams.get('designId'); 

    const [isAddModalOpen, setIsAddModalOpen] = useState(false);
    const [isEditOpen, setIsEditOpen] = useState(false);
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [selectedDesign, setSelectedDesign] = useState(null);
    const [design,setDesign] = useState(null);
    const [designToShow, setDesignToShow] = useState(null);
    const [isDetailsOpen, setIsDetailsOpen] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [designs, setDesigns] = useState([]);

    // useEffect(() => {
    //     console.log("isEditOpen:", isEditOpen,design);
    //   }, [isEditOpen]);
    // console.log(selectedDesign, 'designs');    
    
            
    
    // const handleClick = async (design) => {
    //     const { data, error } = await supabase
    //   .from('starting_info')
    //   .select('*')
    //   .eq('id', design.id);
    // const{data:stones,error:stones_error} = await supabase
    //     .from('stones')
    //     .select('*')
    //     .eq('starting_info_id',data[0].id)

    //   if (error||stones_error) {
    //     console.error('Error fetching design:', error||stones_error);
    //     return;
    //   }
    //   console.log(data,'data from click');
    //     setDesign({...data[0],stones});
    //     setIsDetailsOpen(true);
    // }
    const handleClick = async (design) => {
        // Open the modal immediately
        setIsDetailsOpen(true);
      
        // Show a loading state in the modal
        setDesign(null);
      
        // Fetch the design quote data
        const { data, error } = await supabase
          .from('starting_info')
          .select('*')
          .eq('id', design.id);
      
        const { data: stones, error: stonesError } = await supabase
          .from('stones')
          .select('*')
          .eq('starting_info_id', design.id);
      
        if (error || stonesError) {
          console.error('Error fetching design quote:', error || stonesError);
          setIsDetailsOpen(false); // Close the modal if there's an error
          return;
        }
        const images = getImages('starting_info',design.id)
    
    
    // Update the design data in the modal
        // Update the design quote data in the modal
        setDesign({ ...data[0],...images, stones });
      };
    const updateDesign = (updatedDesigns) => {
        console.log('updated design:', updatedDesigns,designs)
        setDesigns((previousDesign) =>
            previousDesign.map((design) => (design.id === updatedDesigns.id ? updatedDesigns : design))
        );
      };

    if(isLoading){
        return <Loading />
    }
    
    return (
        <div className="p-6">
            <div className="flex flex-wrap justify-between items-center mb-6 gap-2">
                <h1 className="text-2xl font-bold text-gray-900 max-md:text-xl">Design Quotes</h1>
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
                            New Design Quote
                        </button>
                    </div>
                </div>
                <DesignQuoteList
                    designQuotes={designs}
                    setDesignQuotes={setDesigns}
                    // onDesignClick={(design) => {

                    // setIsDetailsOpen(true);
                    // setSelectedDesign(design);
                    // }}
                    onDesignClick={handleClick}
                />


                <AddDesignQuoteModal
                    isOpen={isAddModalOpen}
                    onSave={(design) => {
                        setIsAddModalOpen(false)
                        setDesigns((prev)=> [...prev, design])
                    }}
                    onClose={() => setIsAddModalOpen(false)}
                />
                {design &&
                    <DesignApprovalForm 
                        isOpen={isDetailsOpen}
                        updateDesign={updateDesign}
                        onClose={() =>{ setIsDetailsOpen(false);
                            // setDesign(null)
                        }}
                        design={design}
                        openEditModal={(design) => {
                            setIsEditOpen(true)
                            setDesign(design)

                        }} 
                    />
                }
                {design &&

                    <DesignQuoteInfoModal 
                    isOpen={isEditOpen}
                    onClose={() => setIsEditOpen(false)}
                    design={design}
                    updateDesign={updateDesign}
                    />
                }
                 <ImportModal
  isOpen={isImportModalOpen}
  onClose={() => setIsImportModalOpen(false)}
  onImport={(importedSamples) => {
    setDesigns((prev) => {
      // Create a map of existing samples for quick lookup
      const existingSamplesMap = new Map(prev.map((sample) => [sample.id, sample]));

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
                    type="designQuotes"
                />
        </div>
    )
}
export default DesignQuote;