import React, { useState, useEffect, useRef } from "react";
import { useSupabase } from "../components/SupaBaseProvider";
import { Search } from "lucide-react";
import { Link } from "react-router-dom";
import { useSearchParams } from "react-router-dom";
import { use } from "react";

export default function SearchBar({ items: collectionItems, onSearch,type, setIsLoading, isLoading }) {
  const { supabase } = useSupabase();
  const [searchTerm, setSearchTerm] = useState("");
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
    const [searchParams, setSearchParams] = useSearchParams(); // React Router hook for query params
    const page = parseInt(searchParams.get("page") || "0", 10);
    const source = searchParams.get("source") || "search"; // Default to 'search' if not provided
    const PAGE_SIZE = 20;

  const searchRef = useRef();

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        setSearchTerm("");
        setItems(null);
      }
    };

    if(!collectionItems) document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);
  useEffect(() => {
    if(source !==type){
      return;
    }
    setSearchTerm(searchParams.get("search") || "");
    fetchItems(searchTerm);
  },[page])

  const handleSearchBarFunction = async(searchTerm)=>{

    const { data: samples, error: samplesError } = await supabase
        .from("samples")
        .select("*")
        .or(`styleNumber.ilike.%${searchTerm}%,name.ilike.%${searchTerm}%,starting_description.ilike.%${searchTerm}%,manufacturerCode.ilike.%${searchTerm}%,notes.ilike.%${searchTerm}%`);

      if (samplesError) throw samplesError;

      const { data: ideas, error: ideasError } = await supabase
        .from("ideas")
        .select("*")
        .ilike("name", `%${searchTerm}%`);

      if (ideasError) throw ideasError;

      // const { data: quotes, error: quotesError } = await supabase
      //   .from("quotes")
      //   .select("*")
      //   .or(`buyer.ilike.%${searchTerm}%`);

      // if (quotesError) throw quotesError;
      let quotesById = [];

      if (!isNaN(parseInt(searchTerm))) {
        const { data, error: quotesError2 } = await supabase
          .from("quotes")
          .select("*")
          .eq("id", Number(searchTerm));

        if (quotesError2) throw quotesError2;

        quotesById = data || [];
      }

      // const { data: vendors, error: vendorsError } = await supabase
      //   .from('vendors')
      //   .select('*')
      //   .or(`name.ilike.%${searchTerm}%,email.ilike.%${searchTerm}%`);

      // if (vendorsError) throw vendorsError;

      const { data: designs, error: designsError } = await supabase
        .from("designs")
        .select("*")
        .or(`name.ilike.%${searchTerm}%`);

      if (designsError) throw designsError;

      const combinedResults = [
        ...samples.map((sample) => ({
          ...sample,
          table: "samples",
          linkTo: `/samples?sampleId=${sample.id}`,
          display: sample.name || sample.styleNumber,
        })),
        ...ideas.map((idea) => ({
          ...idea,
          table: "ideas",
          linkTo: `/ideas?ideaId=${idea.id}`,
          display: idea.name,
        })),
        // ...quotes.map((quote) => ({
        //   ...quote,
        //   table: "quotes",
        //   linkTo: `/ViewQuote?quote=${quote.quoteNumber}`,
        //   display: quote.buyer || quote.quoteNumber,
        // })),
        ...quotesById.map((quote) => ({
          ...quote,
          table: "quotes",
          linkTo: `/ViewQuote?quote=${quote.quoteNumber}`,
          display: quote.buyer || `Quote: ${quote.id}`,
        })),
        // ...vendors.map((vendor) => ({
        //   ...vendor,
        //   table: 'vendors',
        //   linkTo: '',
        //   display: vendor.name || vendor.email
        // })),
        ...designs.map((design) => ({
          ...design,
          table: "designs",
          linkTo: `/designs?designId=${design.id}`,
          display: design.name,
        })),
      ];

      setItems(combinedResults.filter((item) => item.display));
  }
  // const handleImageSearch = async (searchTerm) =>{
  //   const {data,error}=await supabase
  //   .from('image_link')
  //   .select('id,imageId(imageUrl)')
  //   // .select('styleNumber')
  //   .ilike('styleNumber',`%${searchTerm}%`)

  //   if (error) {
  //     console.error('Search error:', error);
  //   } else {
  //     console.log('Search results:', data);
  //   }
  //   const imageUrls = data
  // .filter((item) => item.imageId && item.imageId.imageUrl)
  // .map((item) => ({id:item.id,name:item.imageId.imageUrl.split('public/').pop(),url:item.imageId.imageUrl}));
  //   onSearch([...new Set([...imageUrls,...collectionItems])])
  // }
  
  
  //the problem i am having is that the search bar is relaoding all instances when page changes I need to find a way to 
  // only reload the search bar when the search term changes and for the specific type of search 
  const fetchItems = async (searchTerm = "") => {
    if (searchTerm.length <= 2 && searchTerm.length > 0) {
      // console.log("Search term is too short, not fetching items:", searchTerm);
      return;
    }

    setIsLoading(true);
    setError(null);
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;
  
    try {
      let query = supabase; // Start with the Supabase client
      let selects = ""; // Variable to store the table name
      let filters = ""; // Variable to store the filter conditions
  
      // Dynamically set the table and filters based on the type
      switch (type) {
        case "search":
          await handleSearchBarFunction(searchTerm);
          return;
          // break;
        case "image_link":
          selects = "id,imageId(imageUrl)";
          filters = `styleNumber.ilike.%${searchTerm}%`;
          break;
        case "sample_with_stones_export":
          selects = "*";
          filters = `styleNumber.ilike.%${searchTerm}%,name.ilike.%${searchTerm}%,starting_description.ilike.%${searchTerm}%,manufacturerCode.ilike.%${searchTerm}%,notes.ilike.%${searchTerm}%`;
          break;
        case "ideas":
          selects = "*";
          filters = `name.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%`;
          break;
        case "designs":
          selects = "*";
          filters = `name.ilike.%${searchTerm}%,description.ilike.%${searchTerm}%`;
          break;
        default:
          throw new Error("Invalid search type");
      }
  
      // Build and execute the query
      const { data, error } = await query
        .from(type)
        .select(selects)
        .or(filters)
        .range(from, to);
        
  
      if (error) throw error;
  
      // Process the results based on the type
      if (type === "image_link") {
        const imageUrls = data
          .filter((item) => item.imageId && item.imageId.imageUrl)
          .map((item) => ({
            id: item.id,
            name: item.imageId.imageUrl.split("public/").pop(),
            url: item.imageId.imageUrl,
          }));
        onSearch([...new Set([...imageUrls, ...collectionItems])]);
        return;
      } 
      onSearch(data)
      return;
    } catch (err) {
      setError("Error fetching search results");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (searchTerm.length <=2 && searchTerm.length > 0) {
      console.log("Search term is too short, not fetching items:", searchTerm);
      return;
    }
    if (searchTerm.length === 0) {
      console.log("Search term is empty, sending unfiltered items:", collectionItems);

      if (onSearch && collectionItems) {
        onSearch(collectionItems); // Send unfiltered items
      }
      return
    };
    console.log(collectionItems)
    if (collectionItems){
      const filteredItems = collectionItems.filter((item) =>
        item.id == Number(searchTerm) ||
        item.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.styleNumber?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.name?.toLowerCase().includes(searchTerm.toLowerCase())
      
      );

      // onSearch(filteredItems);
      onSearch(filteredItems);
      // if(type!=='images'){
      //   return
      // } 
     
    }



    const delayDebounce = setTimeout(() => {
      fetchItems(searchTerm);
    }, 300); // Adjust debounce delay (ms) as needed

    return () => clearTimeout(delayDebounce);
  }, [searchTerm,collectionItems]);

  return (
    <div ref={searchRef} className="relative w-full max-w-md">
      <div className="relative">
        <input
          type="text"
          placeholder="Search..."
          value={searchTerm}
          onChange={(e) => {
            setSearchParams({search: e.target.value, source:type});
            setSearchTerm(e.target.value)}}
          className="w-full pl-10 pr-4 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <Search className="w-5 h-5 text-gray-400 absolute left-3 top-2.5" />
      </div>

      {searchTerm.length > 0 && items && (
        <ul className="absolute z-10 mt-2 w-full border rounded-md divide-y bg-white shadow-lg max-h-64 overflow-auto">
          {items && items.length > 0 ? (
            <ul className="divide-y divide-gray-200">
              {items.map((item, index) => (
                <li key={index}>
                  <Link
                    to={item.linkTo}
                    onClick={(e) => {
                      setItems(null);
                    }}
                    className="block px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                  >
                    {item.display}
                    <span className="ml-2 text-xs text-gray-400">
                      ({item.table})
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            !isLoading && (
              <div className="p-2 text-sm text-gray-500">No results found</div>
            )
          )}
        </ul>
      )}

      {/* {isLoading && <p className="text-sm text-gray-500 mt-1">isLoading...</p>} */}
      {error && <p className="text-sm text-red-500 mt-1">{error}</p>}
    </div>
  );
};

