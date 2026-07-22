import { useState,useEffect } from 'react'
import { Plus, Upload } from 'lucide-react';
import GridComponenet from '../components/Qoutes/GridComponent'
import AddQuoteModal from '../components/Qoutes/AddQuoteModal'
import { useNavigate } from 'react-router-dom';
import { useSupabase } from '../components/SupaBaseProvider';
import DeleteButton from '../components/MiscComponenets/DeleteButton';
import { useMessage } from '../components/Messages/MessageContext';
import FilterButton from '../components/Filters/FilterButton';

export default function Quote (){
    const navigate = useNavigate()
    const {supabase} = useSupabase();
    const [isLoading, setIsLoading] = useState(true);
    const [isAddModalOpen,setIsAddModalOpen]= useState(false)
    const [quotes,setQuotes ]=useState([])
    const [selected,setSelected] = useState(new Set())
    const {showMessage} = useMessage()

    const handleDelete = async (success)=>{
       
              if(!success)           {
                    showMessage('Error occured while deleting')
                return
              }

        setQuotes(quotes.filter(q => !selected.has(q.id)))
        showMessage('Items have been deleted successfully')
        setSelected(new Set())
    }
   return(
    <div className="p-6">
    <div className="flex flex-wrap justify-between items-center mb-6 gap-2">
        <div className="flex gap-2 ">
            <h1 className="text-2xl font-bold text-gray-900">Quotes</h1>
            <FilterButton type={'quotes'}/>
        </div>
        <div className="flex space-x-3">
                {/* <button 
                    className="bg-white text-gray-700 px-4 py-2 rounded-lg flex items-center hover:bg-gray-50 border border-gray-300"
                    onClick={() => setIsImportModalOpen(true)}
                >
                    <Upload className="w-5 h-5 mr-2" />
                    Import
                </button> */}

                {selected.size>0 &&
                    <DeleteButton 
                    type={'quotes'}
                    selectedItems={selected}
                    onDelete={handleDelete}
                />}
                <button 
                    className="bg-chabot-gold text-white px-4 py-2 rounded-lg flex items-center hover:bg-opacity-90 transition-colors"
                    onClick={() => navigate('/newQuote')}
                >
                    <Plus className="w-5 h-5 mr-2" />
                    New Quote
                </button>
            </div>
        </div>
        
        <div>
            {/* <span>
                filter goes here
            </span> */}
        </div>
        <GridComponenet 
            quotes={quotes}
            setQuotes={setQuotes}
            selected={selected}
            setSelected={setSelected}
        />
        <AddQuoteModal 
            isOpen={isAddModalOpen}
            onClose={()=> setIsAddModalOpen(false)}
            onSave={(newQuote)=> setQuotes([...quotes,newQuote])}
        />


        


    </div>
    
   ) 
}