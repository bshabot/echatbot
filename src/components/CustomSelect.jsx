import React, { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useSupabase } from "./SupaBaseProvider";

function CustomSelect({ onSelect, version, setNewOption, informationFromDataBase, hidden = false, required = false }) {
  const { supabase } = useSupabase();
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);
  

  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [options, setOptions] = useState([]);
  const [newItemName, setNewItemName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState("bottom"); // Track dropdown position

  // console.log(options)
  const filteredCollections = options.filter((option) =>

    option.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  useEffect(() => {
    const fetchData = async () => {
      const data = await getFromDatabase();
      setOptions([{id:null,name:'(remove selection)'}, ...data]);
    };

    fetchData();
  }, []);

  useEffect(() => {
    const handleOutsideClick = (event) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target) &&
        !inputRef.current.contains(event.target)
      ) {
        setIsOpen(false);
        setIsCreating(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, []);

  useEffect(() => {
    if (isOpen) {
      adjustDropdownPosition();
    }
  }, [isOpen]);

  const adjustDropdownPosition = () => {
    const inputRect = inputRef.current.getBoundingClientRect(); // Get input position
    const dropdownHeight = dropdownRef.current?.offsetHeight || 200; // Default dropdown height
    const viewportHeight = window.innerHeight; // Height of the viewport
    const spaceBelow = viewportHeight - inputRect.bottom; // Space below the input
    const spaceAbove = inputRect.top; // Space above the input
  
    // Check if there is enough space below the input
    if (spaceBelow >= dropdownHeight) {
      setDropdownPosition("bottom"); // Default dropdown position
    } else if (spaceAbove >= dropdownHeight) {
      setDropdownPosition("top"); // Invert dropdown
    } else {
      // Handle cases where neither space is sufficient
      if (spaceBelow > spaceAbove) {
        setDropdownPosition("bottom");
        dropdownRef.current.style.maxHeight = `${spaceBelow}px`; // Limit dropdown height
      } else {
        setDropdownPosition("top");
        dropdownRef.current.style.maxHeight = `${spaceAbove}px`; // Limit dropdown height
      }
    }
  };
  const addToDatabase = async (name) => {
    if (version === "collection") return;
    const { data, error } = await supabase.from(`${version}`).insert({ name }).select();
    setOptions((prev) => [...prev, { id: data[0].id, name }]);

    if (error) {
      console.error(`Error adding ${version}:`, error);
    } else {
      console.log(`${version} added:`, data);
    }
  };

const getFromDatabase = async () => {
  let query;
  if (version === "samples") {
    query = supabase.from("samples").select("id,name,styleNumber").order('created_at', { ascending: false });
  } else {
    query = supabase.from(`${version === "collection" ? "ideas" : version}`).select("id,name").order('created_at', { ascending: false });
  }
  const { data, error } = await query;

  if (error) {
    console.error(`Error fetching ${version}:`, error);
  }
  console.log(`${version} fetched:`, data);
  return data
}

  const handleAddCollection = async () => {
    if (newItemName.trim() !== "" && version !== "collection") {
      setIsCreating(false); // Close creation form
      handleSelect({ name: newItemName }); // Close dropdown
      await addToDatabase(newItemName);
      setNewItemName("");
    }
  };

  const handleSelect = (option) => {
    console.log(`Selected: ${option.id}`);
    inputRef.current.value = option.name;
    onSelect({ value: option.id, categories: [version] });
    setIsOpen(false);
  };

  let item = options.find((item) => item.id === Number.parseInt(informationFromDataBase));

  return (
    <div className="relative" id="custom-select">
      {/* Dropdown Trigger */}
      <div className="z-10 relative w-full">
        <input
          ref={inputRef}
          defaultValue={item ? item.name : ""}
          onFocus={() => setIsOpen(true)}
          required={required}
          className="input text-left"
        />
        <ChevronDown className="absolute top-3 right-3 text-gray-500 pointer-events-none" />
      </div>

      {/* Dropdown Options */}
      {isOpen && (
        <div
          className={`absolute z-40 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg w-full ${
            dropdownPosition === "top" ? "bottom-full mb-2" : "top-full mt-2"
          }`}
          ref={dropdownRef}
        >
          {!isCreating ? (
            <>
              <div className="p-2 border-b">
                <input
                  type="text"
                  placeholder="Search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg p-2"
                />
              </div>

              <ul className="max-h-40 overflow-y-auto max-md:max-h-56">
                {filteredCollections.map((collection, index) => (
                  <li
                    key={index}
                    onClick={() => {
                      console.log(`Selected: ${collection.name}`);
                      handleSelect(collection);
                    }}
                    className="p-2 hover:bg-gray-100 cursor-pointer max-md:py-2.5"
                  >
                    {collection.name}
                  </li>
                ))}
                {filteredCollections.length === 0 && (
                  <li className="p-2 text-gray-500">{`No ${version} Found`}</li>
                )}
              </ul>

              <div
                className={`p-2 border-t flex items-center text-blue-500 cursor-pointer ${hidden ? "hidden" : ""}`}
                onClick={() => setIsCreating(true)}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="w-5 h-5 mr-2"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                {`Create ${version}`}
              </div>
            </>
          ) : (
            <div className="p-4">
              <input
                type="text"
                placeholder={`New ${version} name`}
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg p-2 mb-2"
              />
              <div className="flex justify-between">
                <button onClick={() => setIsCreating(false)} className="px-4 py-2 bg-gray-200 rounded-lg">
                  Cancel
                </button>
                <button onClick={handleAddCollection} className="px-4 py-2 bg-chabot-gold text-white rounded-lg">
                  Save
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default CustomSelect;