import { useState,useEffect } from 'react'
import { Plus, Upload, Truck, X } from 'lucide-react';
import { createSampleLabel } from '../utils/upsLabels';
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

    // UPS sample label (Brian 7/30): one input — the buyer's name. Fixed
    // recipe: Texoma sample room (Coppell TX), 8×3×6 in, 1 lb, 2nd Day Air,
    // 3rd-party billed to Signet. PDF downloads; tracking shows for copying.
    const [sampleOpen, setSampleOpen] = useState(false)
    const [buyer, setBuyer] = useState('')
    const [sampleBusy, setSampleBusy] = useState(false)
    const [sampleMsg, setSampleMsg] = useState('')

    const sendSample = async () => {
        if (!buyer.trim() || sampleBusy) return
        setSampleBusy(true)
        setSampleMsg('')
        try {
            const res = await createSampleLabel(supabase, buyer.trim())
            setSampleMsg(`Label created for ${buyer.trim()} — tracking ${res.packages[0]?.tracking}. PDF downloaded.`)
            setBuyer('')
        } catch (e) {
            showMessage('UPS label failed: ' + e.message)
        } finally {
            setSampleBusy(false)
        }
    }

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
                    className="bg-white text-gray-700 px-4 py-2 rounded-lg flex items-center hover:bg-gray-50 border border-gray-300"
                    title="UPS 2nd Day Air label to the Texoma sample room — just type the buyer's name"
                    onClick={() => { setSampleOpen(true); setSampleMsg(''); }}
                >
                    <Truck className="w-5 h-5 mr-2" />
                    UPS sample label
                </button>
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

        {sampleOpen && (
            <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                <div className="bg-white rounded-lg shadow-xl w-full max-w-sm">
                    <div className="flex items-center justify-between px-5 py-4 border-b">
                        <div>
                            <div className="font-semibold text-lg">UPS sample label</div>
                            <div className="text-sm text-gray-500">Texoma sample room · 8×3×6 in · 1 lb · 2nd Day Air · billed to Signet</div>
                        </div>
                        <button onClick={() => setSampleOpen(false)} className="text-gray-400 hover:text-gray-600"><X size={20}/></button>
                    </div>
                    <div className="px-5 py-4">
                        <label className="block text-sm text-gray-600 mb-1">Buyer name (prints as ATTN on the label)</label>
                        <input
                            autoFocus
                            value={buyer}
                            onChange={(e) => setBuyer(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') sendSample() }}
                            placeholder="Jenna Wilde"
                            className="w-full border rounded px-3 py-2 text-sm"
                        />
                        {sampleMsg && <div className="text-xs mt-2 text-green-700">{sampleMsg}</div>}
                    </div>
                    <div className="flex justify-end gap-2 px-5 py-4 border-t bg-gray-50 rounded-b-lg">
                        <button onClick={() => setSampleOpen(false)} className="px-4 py-2 text-sm rounded border hover:bg-gray-100">Close</button>
                        <button
                            onClick={sendSample}
                            disabled={sampleBusy || !buyer.trim()}
                            className="px-4 py-2 text-sm rounded bg-gray-900 text-white hover:bg-black disabled:opacity-50"
                        >
                            {sampleBusy ? 'Talking to UPS…' : 'Create label + PDF'}
                        </button>
                    </div>
                </div>
            </div>
        )}


        


    </div>
    
   ) 
}