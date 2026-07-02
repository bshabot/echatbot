import React, { useState, useEffect, useRef } from 'react';
import { Download } from 'lucide-react';
import { exportToCSV } from '../../utils/exportUtils';
import DesignQuoteCard from './DesignQuoteCard';
import { useSupabase } from '../SupaBaseProvider';
import { useLocation } from 'react-router-dom';

const DesignQuoteList = ({ onDesignClick,designQuotes,setDesignQuotes }) => {
  // const [designQuotes, setDesignQuotes] = useState([]);
  const [selectedDesigns, setSelectedDesigns] = useState(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const location = useLocation(); // Access the current URL
  const queryParams = new URLSearchParams(location.search); // Parse the query string
  const designId = queryParams.get('designId'); 


  const { supabase } = useSupabase();
  const PAGE_SIZE = 20;

  const hasFetchedQuotes = useRef(false);
//   useEffect(()=>{

//     const fetchDesignQuote = async () => {
//         setLoading(true);
//         console.log(designId,'designId from params')
//         let query = supabase.from('starting_info').select('*');
//         if (designId) {
//             setDesigns([])
//             query = query.eq('designId', designId);
//         }else{
//             query = query.order('created_at', { ascending: false }).limit(12); // Replace 'created_at' with your timestamp column
//         }
//         const { data, error } = await query; // Use the modified query here
//         console.log(query,data)

//         console.log(data, 'data from supabase');
//         if (error) {

//           console.error('Error fetching design quotes:', error);
//           setLoading(false);
//           return;
//         }
//         setDesigns(data);
//         setLoading(false); // Moved this line up for clarity
//       };
//       fetchDesignQuote(); 
// },[])


  // Fetch design quotes from Supabase
  const fetchDesignQuotes = async (pageNumber) => {
    setLoading(true);
    const from = pageNumber * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
        let query = supabase.from('starting_info').select('*');

            if (designId) {
                  // setDesigns([])
                  query = query.eq('designId', designId);
              }else{
                  query = query.order('created_at', { ascending: false })
                  .range(from, to);
              }
    const { data, error } = await query

    if (error) {
      console.error('Error fetching design quotes:', error);
      setLoading(false);
      return;
    }

    if (data.length < PAGE_SIZE) setHasMore(false);

    setDesignQuotes((prevQuotes) => [...prevQuotes, ...data]);
    setPage(pageNumber + 1);
    setLoading(false);
  };

  // Initial fetch
  useEffect(() => {
    if (!hasFetchedQuotes.current) {
      fetchDesignQuotes(0); // Fetch the first page
      hasFetchedQuotes.current = true;
    }
  }, []);

  // Infinite scroll on the PAGE scroll (the list no longer has its own
  // scroll container — one scrollbar, like the other card pages).
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      const nearBottom = el.scrollHeight - (window.scrollY + window.innerHeight) < 300;
      if (nearBottom && !loading && hasMore) {
        fetchDesignQuotes(page);
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [page, loading, hasMore]);

  const handleExport = () => {
    const designsToExport = designQuotes.filter((p) => selectedDesigns.has(p.id));
    exportToCSV(designsToExport);
    setSelectedDesigns(new Set());
    setIsSelectionMode(false);
  };

  const toggleDesignSelection = (design) => {
    const newSelection = new Set(selectedDesigns);
    if (newSelection.has(design.id)) {
      newSelection.delete(design.id);
    } else {
      newSelection.add(design.id);
    }
    setSelectedDesigns(newSelection);
  };


  return (
    <div className="flex flex-col">
      {
          designQuotes.length === 0 ?
            <div className="flex justify-center items-center py-24 text-gray-500">No Design Quotes Found For This Design</div>
         :
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
        
        {designQuotes.map((design) => (
          <DesignQuoteCard
          key={design.id}
          design={design}
          onClick={isSelectionMode ? toggleDesignSelection : onDesignClick}
          selected={selectedDesigns.has(design.id)}
          selectable={isSelectionMode}
          />
        ))}
      </div>
    }
      {loading && <div className="text-center py-4">Loading...</div>}
    </div>
  );
};

export default DesignQuoteList;