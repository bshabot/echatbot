import React, { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import { useSupabase } from "./SupaBaseProvider";

function CustomSelect({ onSelect, version, field, setNewOption, informationFromDataBase, hidden = false, required = false }) {
  const { supabase } = useSupabase();
  const inputRef = useRef(null);
  const dropdownRef = useRef(null);
  

  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [options, setOptions] = useState([]);
  const [newItemName, setNewItemName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  // Plating options carry a spec (material + micron) that lives in
  // plating_layers. These drive the inline create/edit form for version="plating".
  const [platingMaterials, setPlatingMaterials] = useState([]);
  const [newSpec, setNewSpec] = useState({ material: "", micron: "" });
  const [editingId, setEditingId] = useState(null);
  const [editSpec, setEditSpec] = useState({ material: "", micron: "" });
  const [dropdownPosition, setDropdownPosition] = useState("bottom"); // Track dropdown position

  // console.log(options)
  // "RHD" -> "rhodium 0.75mic", "BPT + GPT" -> "rhodium 0.75mic + gold 14k 0.5mic"
  const platingSpec = (option) => {
    const layers = [...(option.plating_layers || [])].sort((a, b) => a.sequence - b.sequence);
    if (!layers.length) return "";
    return layers
      .map((l) =>
        [l.plating_material, l.plating_micron != null ? `${l.plating_micron}mic` : null]
          .filter(Boolean)
          .join(" ")
      )
      .filter(Boolean)
      .join(" + ");
  };

  const filteredCollections = options.filter((option) =>
    option.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const refresh = async () => {
    const data = await getFromDatabase();
    setOptions([{ id: null, name: "(remove selection)" }, ...(data || [])]);
  };

  useEffect(() => {
    refresh();
    if (version === "plating") {
      (async () => {
        const { data } = await supabase
          .from("ssp_vocabulary")
          .select("value")
          .eq("field", "platingMaterial")
          .eq("is_active", true)
          .order("value");
        setPlatingMaterials((data || []).map((r) => r.value));
      })();
    }
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
  } else if (version === "plating") {
    // Pull the layers so the option can show its micron -- "RHD" alone does
    // not tell you whether it is 0.75 or 1 micron, and that drives both the
    // tag and the SSP plating block.
    query = supabase
      .from("plating")
      .select("id,name,plating_layers(sequence,plating_material,plating_micron)")
      .order('created_at', { ascending: false });
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
    if (newItemName.trim() === "" || version === "collection") return;

    if (version === "plating") {
      // Name carries the micron so the list reads as a spec, not a code.
      const micron = newSpec.micron === "" ? null : Number(newSpec.micron);
      const label = micron != null ? `${newItemName.trim()} ${micron}mic` : newItemName.trim();
      const { data, error } = await supabase
        .from("plating")
        .insert({ name: label })
        .select()
        .single();
      if (error) {
        console.error("Error adding plating:", error);
        return;
      }
      if (newSpec.material || micron != null) {
        await supabase.from("plating_layers").insert({
          plating_id: data.id,
          sequence: 1,
          plating_material: newSpec.material || null,
          plating_micron: micron,
        });
      }
      setIsCreating(false);
      setNewItemName("");
      setNewSpec({ material: "", micron: "" });
      await refresh();
      handleSelect({ id: data.id, name: label });
      return;
    }

    setIsCreating(false);
    handleSelect({ name: newItemName });
    await addToDatabase(newItemName);
    setNewItemName("");
  };

  // Edit an existing plating's spec without leaving the dropdown.
  const startEdit = (option) => {
    const layer = [...(option.plating_layers || [])].sort((a, b) => a.sequence - b.sequence)[0];
    setEditingId(option.id);
    setEditSpec({
      material: layer?.plating_material || "",
      micron: layer?.plating_micron ?? "",
    });
  };

  const saveEdit = async (option) => {
    const micron = editSpec.micron === "" ? null : Number(editSpec.micron);
    const layer = [...(option.plating_layers || [])].sort((a, b) => a.sequence - b.sequence)[0];
    if (layer) {
      await supabase
        .from("plating_layers")
        .update({ plating_material: editSpec.material || null, plating_micron: micron })
        .eq("id", layer.id);
    } else {
      await supabase.from("plating_layers").insert({
        plating_id: option.id,
        sequence: 1,
        plating_material: editSpec.material || null,
        plating_micron: micron,
      });
    }
    // keep the micron in the name in step with the spec
    const base = option.name.replace(/\s*[\d.+]+mic$/i, "").trim();
    const label = micron != null ? `${base} ${micron}mic` : base;
    if (label !== option.name) await supabase.from("plating").update({ name: label }).eq("id", option.id);
    setEditingId(null);
    await refresh();
  };

  const handleSelect = (option) => {
    console.log(`Selected: ${option.id}`);
    inputRef.current.value = option.name;
    onSelect({ value: option.id, categories: [field || version] });
    setIsOpen(false);
  };

  let item = options.find((item) => item.id === Number.parseInt(informationFromDataBase));
  const itemSpec = version === "plating" && item ? platingSpec(item) : "";

  return (
    <div className="relative" id="custom-select">
      {/* Dropdown Trigger */}
      <div className="z-10 relative w-full">
        <input
          ref={inputRef}
          defaultValue={item ? (itemSpec ? `${item.name} — ${itemSpec}` : item.name) : ""}
          onFocus={() => setIsOpen(true)}
          required={required}
          className="input text-left"
        />
        <ChevronDown className="absolute top-3 right-3 text-gray-500 pointer-events-none" />
      </div>

      {/* Dropdown Options */}
      {isOpen && (
        <div
          className={`absolute z-40 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg w-full overflow-hidden ${
            version === "plating" ? "min-w-[300px]" : ""
          } ${dropdownPosition === "top" ? "bottom-full mb-2" : "top-full mt-2"}`}
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

              <ul className="max-h-64 overflow-y-auto overflow-x-hidden max-md:max-h-72">
                {filteredCollections.map((collection, index) =>
                  version === "plating" && editingId === collection.id ? (
                    <li key={index} className="p-3 bg-gray-50 border-y border-gray-200">
                      <div className="text-[13px] font-medium text-gray-800 mb-2 truncate">
                        {collection.name}
                      </div>
                      <div className="space-y-2">
                        <label className="block">
                          <span className="text-[11px] text-gray-500">Plating type</span>
                          <select
                            value={editSpec.material}
                            onChange={(e) => setEditSpec((p) => ({ ...p, material: e.target.value }))}
                            className="mt-0.5 w-full border border-gray-300 rounded-lg p-1.5 text-[13px] bg-white"
                          >
                            <option value="">(none)</option>
                            {platingMaterials.map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </label>
                        <label className="block">
                          <span className="text-[11px] text-gray-500">Micron</span>
                          <input
                            value={editSpec.micron}
                            onChange={(e) => setEditSpec((p) => ({ ...p, micron: e.target.value }))}
                            placeholder="0.75"
                            inputMode="decimal"
                            className="mt-0.5 w-full border border-gray-300 rounded-lg p-1.5 text-[13px]"
                          />
                        </label>
                      </div>
                      <div className="flex justify-end gap-2 mt-3">
                        <button type="button" onClick={() => setEditingId(null)}
                          className="px-3 py-1.5 text-[12px] bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                          Cancel
                        </button>
                        <button type="button" onClick={() => saveEdit(collection)}
                          className="px-3 py-1.5 text-[12px] bg-chabot-gold text-white rounded-lg">
                          Save
                        </button>
                      </div>
                    </li>
                  ) : (
                    <li
                      key={index}
                      onClick={() => handleSelect(collection)}
                      className="group px-3 py-2 hover:bg-gray-50 cursor-pointer max-md:py-2.5 flex items-start gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]" title={collection.name}>
                          {collection.name}
                        </div>
                        {version === "plating" && platingSpec(collection) ? (
                          <div className="truncate text-[11px] text-gray-500" title={platingSpec(collection)}>
                            {platingSpec(collection)}
                          </div>
                        ) : null}
                      </div>
                      {version === "plating" && collection.id ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            startEdit(collection);
                          }}
                          className="shrink-0 text-[11px] text-gray-400 hover:text-blue-600 opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                        >
                          Edit
                        </button>
                      ) : null}
                    </li>
                  )
                )}
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
                placeholder={version === "plating" ? "Plating name (e.g. RHD)" : `New ${version} name`}
                value={newItemName}
                onChange={(e) => setNewItemName(e.target.value)}
                className="w-full border border-gray-300 rounded-lg p-2 mb-2"
              />
              {version === "plating" ? (
                <div className="space-y-2 mb-3">
                  <label className="block">
                    <span className="text-[11px] text-gray-500">Plating type</span>
                    <select
                      value={newSpec.material}
                      onChange={(e) => setNewSpec((p) => ({ ...p, material: e.target.value }))}
                      className="mt-0.5 w-full border border-gray-300 rounded-lg p-2 text-[13px] bg-white"
                    >
                      <option value="">(none)</option>
                      {platingMaterials.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-gray-500">Micron</span>
                    <input
                      value={newSpec.micron}
                      onChange={(e) => setNewSpec((p) => ({ ...p, micron: e.target.value }))}
                      placeholder="0.75"
                      inputMode="decimal"
                      className="mt-0.5 w-full border border-gray-300 rounded-lg p-2 text-[13px]"
                    />
                  </label>
                  <p className="text-[11px] text-gray-400">
                    The micron is added to the name automatically.
                  </p>
                </div>
              ) : null}
              <div className="flex justify-between">
                <button type="button" onClick={() => setIsCreating(false)}
                  className="px-3 py-1.5 text-[13px] bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                  Cancel
                </button>
                <button type="button" onClick={handleAddCollection}
                  className="px-3 py-1.5 text-[13px] bg-chabot-gold text-white rounded-lg">
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