import { useState,useEffect } from 'react'
import { Plus, Upload, Truck, X, Landmark } from 'lucide-react';
import { createSampleLabel } from '../utils/upsLabels';
import GridComponenet from '../components/Qoutes/GridComponent'
import AddQuoteModal from '../components/Qoutes/AddQuoteModal'
import { useNavigate } from 'react-router-dom';
import { useSupabase } from '../components/SupaBaseProvider';
import DeleteButton from '../components/MiscComponenets/DeleteButton';
import { useMessage } from '../components/Messages/MessageContext';
import FilterButton from '../components/Filters/FilterButton';
import useRememberedSearchParams from '../Hooks/useRememberedSearchParams';
import { useAlert } from '../components/Alerts/AlertContext';
import { useGenericStore } from '../store/VendorStore';
import { isQbEnabled } from '../utils/qbClient';
import { buildQuoteSoLines, createSalesOrderForQuote } from '../utils/qbQuoteSalesOrder';
import { createItemsForSamples } from '../utils/qbItems';
import { prepareQuoteOrders, sendQuoteOrders } from '../utils/quoteQbBatch';
import { logEvent } from '../utils/logEvent';

export default function Quote (){
    const navigate = useNavigate()
    useRememberedSearchParams('quotes')
    const {supabase} = useSupabase();
    const [isLoading, setIsLoading] = useState(true);
    const [isAddModalOpen,setIsAddModalOpen]= useState(false)
    const [quotes,setQuotes ]=useState([])
    const [selected,setSelected] = useState(new Set())
    const {showMessage} = useMessage()
    const { showConfirm } = useAlert()

    // Send the ticked quotes to QuickBooks as sales orders (same order the quote page's
    // button makes, but the whole quote): customer Zales memo, sales prices, memo = Reference.
    // Styles that aren't in QuickBooks yet are created as items first.
    const settings = useGenericStore((state) => state.getEntity('settings'))
    const vendors = useGenericStore((state) => state.getEntity('vendors'))
    const qbOn = isQbEnabled(settings)
    const [qbBusy, setQbBusy] = useState(false)
    const sendSelectedToQb = async () => {
        if (qbBusy) return
        const picked = quotes.filter((q) => selected.has(q.id))
        if (!picked.length) return
        setQbBusy(true)
        try {
            const { data, error } = await supabase
                .from('quote_with_lineitems_and_product')
                .select('*')
                .in('quoteNumber', picked.map((q) => q.quoteNumber))
            if (error) throw error
            const idByNumber = new Map(picked.map((q) => [q.quoteNumber, q.id]))
            const orders = prepareQuoteOrders(data || [], {
                buildLines: buildQuoteSoLines,
                labelFor: (r) => '#' + (idByNumber.get(r.quoteNumber) ?? r.quoteNumber),
            })
            const sendable = orders.filter((o) => !o.problems.length && o.lines.length)
            const skipped = orders.filter((o) => o.problems.length || !o.lines.length)
            const logQb = (level, message, details) =>
                logEvent(supabase, { level, source: 'qb-quote-sales-order', action: 'create', message, details })
            if (!sendable.length) {
                void logQb('error', 'Send to QB: nothing to send — ' + skipped.map((o) => `${o.label} ${o.problems.join('; ') || 'has no lines'}`).join(' | '),
                    { quotes: skipped.map((o) => ({ quoteNumber: o.quoteNumber, problems: o.problems })) })
                showMessage("Nothing to send: " + skipped.map((o) => `${o.label} ${o.problems.join('; ') || 'has no lines'}`).join(' | '), { type: 'error' })
                return
            }
            const ok = await showConfirm(
                <div className="text-sm space-y-2">
                    <p>
                        Create {sendable.length} QuickBooks sales order{sendable.length === 1 ? '' : 's'} for <strong>Zales</strong> at
                        the quotes' sales prices. Any style not in QuickBooks yet is created as an item first.
                    </p>
                    <ul className="max-h-48 overflow-y-auto divide-y divide-gray-100 border border-gray-200 rounded">
                        {sendable.map((o) => (
                            <li key={o.quoteNumber} className="flex justify-between gap-3 px-2 py-1">
                                <span>Quote {o.label}{o.reference ? ` · ${o.reference}` : ''} · {o.lines.length} item{o.lines.length === 1 ? '' : 's'}</span>
                                <span>${o.total.toFixed(2)}</span>
                            </li>
                        ))}
                    </ul>
                    {skipped.length > 0 && (
                        <p className="text-amber-700">
                            Not sent: {skipped.map((o) => `${o.label} (${o.problems.join('; ') || 'no lines'})`).join(', ')}
                        </p>
                    )}
                    <p className="text-gray-500">QuickBooks assigns the order numbers. Sending the same quote again won't create a duplicate.</p>
                </div>,
                { title: 'Send to QuickBooks', confirmText: `Send ${sendable.length}` }
            )
            if (!ok) return
            const out = await sendQuoteOrders(orders, {
                createItems: (products) => createItemsForSamples(products, { settings, vendors, supabase }),
                createOrder: ({ quoteNumber, reference, selectedLines }) =>
                    createSalesOrderForQuote({ quoteNumber, reference, selectedLines, settings }),
            })
            if (out.enabled === false) {
                showMessage('QuickBooks integration is off in Settings', { type: 'error' })
                return
            }
            // Every outcome goes to the activity log (Settings > Sync logs), not just the toast.
            for (const f of out.items.failed) {
                void logQb('error', `Send to QB: item ${f.sample} could not be created — ${f.error}`, { item: f })
            }
            for (const r of out.results) {
                if (r.status === 'created') void logQb('success', `Send to QB: quote ${r.label} created as sales order ${r.ref ? '#' + r.ref : ''}`.trim(), r)
                else if (r.status === 'maybe') void logQb('error', `Send to QB: quote ${r.label} timed out, check QuickBooks before resending — ${r.error}`, r)
                else void logQb('error', `Send to QB: quote ${r.label} ${r.status} — ${r.error}`, r)
            }
            const made = out.results.filter((r) => r.status === 'created')
            const maybe = out.results.filter((r) => r.status === 'maybe')
            const bad = out.results.filter((r) => r.status === 'failed' || r.status === 'skipped')
            const parts = []
            if (made.length) parts.push(`${made.length} sales order${made.length === 1 ? '' : 's'} created (${made.map((r) => (r.ref ? '#' + r.ref : r.label)).join(', ')})`)
            if (out.items.created.length) parts.push(`${out.items.created.length} new item${out.items.created.length === 1 ? '' : 's'} added to QuickBooks`)
            if (maybe.length) parts.push(`${maybe.map((r) => r.label).join(', ')}: QuickBooks didn't answer in time, check QuickBooks before sending again`)
            if (bad.length) parts.push(`not sent: ${bad.map((r) => `${r.label} (${r.error})`).join('; ')}`)
            showMessage(parts.join('. '), { type: bad.length || maybe.length ? 'error' : 'success' })
        } catch (e) {
            void logEvent(supabase, {
                level: 'error', source: 'qb-quote-sales-order', action: 'create',
                message: 'Send to QB failed: ' + (e?.message || e),
                details: { quotes: picked.map((q) => q.quoteNumber), stack: e?.stack || null },
            })
            showMessage('Send to QuickBooks failed: ' + (e?.message || e), { type: 'error' })
        } finally {
            setQbBusy(false)
        }
    }

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

                {qbOn && selected.size>0 &&
                    <button
                        className="bg-green-600 text-white px-4 py-2 rounded-lg flex items-center hover:bg-green-700 disabled:opacity-60"
                        title="Create a QuickBooks sales order for each ticked quote (missing items are created first)"
                        onClick={sendSelectedToQb}
                        disabled={qbBusy}
                    >
                        <Landmark className="w-5 h-5 mr-2" />
                        {qbBusy ? 'Sending…' : `Send to QB (${selected.size})`}
                    </button>}
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