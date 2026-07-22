import { ListFilter } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { useSupabase } from "../SupaBaseProvider";
import { useRef, useEffect, useState } from "react";

export default function FilterButton({ type }) {
  const { supabase } = useSupabase();
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  // State for filter options
  const [customers, setCustomers] = useState([]);
  const [collections, setCollections] = useState([]);
  const [types, setTypes] = useState([]);
  const [categories, setCategories] = useState([]);
  const [metals, setMetals] = useState([]);
  const [stones, setStones] = useState([]);
  const [chains, setChains] = useState([{ name: "Yes" }, { name: "No" }]); // Example chain options

  // Fetch unique values for filters on mount
  useEffect(() => {
    async function loadFilters() {
      try {
        const [
          { data: customersData },
          { data: collectionsData },
          //   { data: typesData },
          { data: categoriesData },
          { data: metalsData },
          //   { data: stonesData },
        ] = await Promise.all([
          supabase
            .from("customers")
            .select("id,name", { distinct: true, order: "name" }),
          supabase
            .from("ideas")
            .select("id,name", { distinct: true, order: "name" }),
          //   supabase.from('products').select('type', { distinct: true, order: 'type' }),
          supabase
            .from("category")
            .select("id,name", { distinct: true, order: "name" }),
          supabase.rpc("get_distinct_metals"),
          //   supabase.from('stones').select('stone', { distinct: true, order: 'stone' }),
        ]);
        // sample_with_stones_export ,
        setCustomers(customersData || []);
        setCollections(collectionsData || []);
        // setTypes(typesData || []);
        setCategories(categoriesData || []);
        setMetals(metalsData || []);
        // setStones(stonesData || []);
      } catch (error) {
        console.error("Error loading filters", error);
      }
    }
    loadFilters();
  }, [supabase]);
  const modalRef = useRef();

  useEffect(() => {
    function handleClickOutside(event) {
      if (modalRef.current && !modalRef.current.contains(event.target)) {
        setFilterModalOpen(false);
      }
    }

    if (filterModalOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [filterModalOpen]);

  // Helper to update search params on filter change
  function toggleFilterParam(key, value) {
    const currentValues = searchParams.getAll(key);

    if (currentValues.includes(value.toString())) {
      // Remove value
      const newValues = currentValues.filter((v) => v !== value.toString());
      searchParams.delete(key);
      newValues.forEach((v) => searchParams.append(key, v));
    } else {
      // Add value
      searchParams.append(key, value.toString());
    }

    // ✅ Reset page to 0
    searchParams.set("page", "0");

    setSearchParams(searchParams);
  }

  // Render filter dropdown (checkbox list)
  function renderFilterList(title, paramKey, options) {
    const selectedValues = searchParams.getAll(paramKey);
    console.log(selectedValues, "options from filter button");
    return (
      <div className="p-2 border-b border-gray-200">
        <div className="font-semibold mb-1">{title}</div>
        {options.map((opt) => {
          const name = opt.name; // e.g. opt.customer for customers, etc
          const value = opt.id || name; // Use id for customers, collections, etc.
          if (!value) return null;
          const checked = selectedValues.includes(value.toString());
          return (
            <label key={value} className="block cursor-pointer max-md:py-1.5">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggleFilterParam(paramKey, value)}
                className="mr-2 max-md:w-4 max-md:h-4"
              />
              {name}
            </label>
          );
        })}
      </div>
    );
  }

  return (
    <div className="relative">
      <button
        className="px-2 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
        onClick={() => setFilterModalOpen((open) => !open)}
      >
        <ListFilter />
      </button>
      {filterModalOpen && (
        <div
          className="absolute z-40 mt-2 w-72 max-w-[calc(100vw-4rem)] right-0 max-h-96 overflow-auto bg-white border border-gray-300 rounded-lg shadow-lg p-2"
          ref={modalRef}
        >
          {type === "designs" ? (
            <>
              {renderFilterList("Categories", "category", categories)}
              {renderFilterList("Collections", "collection", collections)}
            </>
          ) : (
            <>
              {renderFilterList("Customers", "customer", customers)}
              {renderFilterList("Metals", "metal", metals)}
              {renderFilterList("Chains", "chain", chains)}
              {renderFilterList("Categories", "category", categories)}
              {renderFilterList("Collections", "collection", collections)}
            </>
          )}
          {/* {renderFilterList('Types', 'type', types)} */}
          {/* {renderFilterList('Stones', 'stone', stones)} */}
        </div>
      )}
    </div>
  );
}
