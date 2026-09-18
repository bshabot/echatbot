import React, { useState } from "react";
import { useGenericStore } from "../../store/VendorStore";

const DEFAULT_STONE = {
  type: "cz",
  color: "white",
  customType: "",
  shape: "round",
  size: "",
  quantity: 1,
  cost: 0,
  setting_type: "",
};

// Add-or-edit form for one stone. Passing `initialStone` (with `isEditing`)
// pre-fills every field -- including the DB `id`, so StonePropertiesForm's
// submit handler can tell "replace this stone" from "append a new one" --
// instead of the old add-only form that made fixing a typo mean deleting
// the stone and re-entering all of its fields from scratch.
const StoneForm = ({ onSubmit, onCancel, initialStone = null, isEditing = false }) => {
  const { getEntity } = useGenericStore();
  const  {stonePropertiesForm}  = getEntity("settings").options;
  const [stone, setStone] = useState(() => ({ ...DEFAULT_STONE, ...(initialStone || {}) }));
  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit(stone);
  };
  // Cost input: plain numeric parsing, capped to 2 decimal places. The
  // previous version did `value.slice(1)` on every keystroke that wasn't
  // adding a 3rd decimal digit, which silently chopped the first character
  // off whatever was typed (e.g. typing "50" landed as 0) -- so a stone's
  // cost could be wrong even when the save itself succeeded.
  const handleCostChange = (e) => {
    let value = e.target.value;
    if (value === "") {
      setStone({ ...stone, cost: "" });
      return;
    }
    if (value.includes(".") && value.split(".")[1]?.length > 2) {
      value = value.slice(0, value.indexOf(".") + 3);
    }
    const parsed = parseFloat(value);
    setStone({ ...stone, cost: Number.isNaN(parsed) ? 0 : parsed });
  };
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Type
          </label>
          <select
            name="type"
            id="type"
            value={stone.type}
            onChange={(e) => setStone({ ...stone, type: e.target.value })}
            className="mt-1 block w-full input rounded-md border-gray-300 shadow-sm focus:ring-chabot-gold focus:border-chabot-gold"
          >
            {stonePropertiesForm?.type?.map((color, index) => (
              <option key={index} value={color.toLowerCase()}>
                {color}
              </option>
            ))}
            
            {/* <option value="other">Other</option> */}
          </select>
          {stone.type === "other" && (
            <input
              type="text"
              value={stone.customType || ""}
              onChange={(e) =>
                setStone({ ...stone, customType: e.target.value })
              }
              placeholder="Enter stone type"
              className="mt-2 block w-full input rounded-md border-gray-300 shadow-sm focus:ring-chabot-gold focus:border-chabot-gold"
            />
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Color
          </label>
          <select
            id="color"
            name="color"
            value={stone.color}
            onChange={(e) => setStone({ ...stone, color: e.target.value })}
            className="mt-1 block w-full input rounded-md border-gray-300 shadow-sm focus:ring-chabot-gold focus:border-chabot-gold"
          >
            {stonePropertiesForm?.color?.map((color, index) => (
              <option key={index} value={color.toLowerCase()}>
                {color}
              </option>
            ))}
            {/* <option value="other">Other</option> */}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Size (mm)
          </label>
          <input
            type="text"
            value={stone.size}
            onChange={(e) => setStone({ ...stone, size: e.target.value })}
            placeholder="e.g. 6"
            className="mt-1 block w-full input rounded-md border-gray-300 shadow-sm focus:ring-chabot-gold focus:border-chabot-gold"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Quantity
          </label>
          <input
            type="number"
            min="1"
            value={stone.quantity}
            onChange={(e) => {
              const parsed = parseInt(e.target.value, 10);
              setStone({ ...stone, quantity: Number.isNaN(parsed) ? "" : parsed });
            }}
            className="mt-1 block w-full input rounded-md border-gray-300 shadow-sm focus:ring-chabot-gold focus:border-chabot-gold"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700">
            Cost (total)
          </label>
          <div className="mt-1 relative rounded-md shadow-sm">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <span className="text-gray-500 sm:text-sm">$</span>
            </div>
            <input
              type="number"
              step="0.01"
              min="0"
              name="cost"
              value={stone.cost ?? 0}
              onChange={handleCostChange}
              className="block w-full input pl-7 pr-3 py-2 rounded-md border-gray-300 focus:ring-chabot-gold focus:border-chabot-gold"
            />
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Setting Type
          </label>
          <select
            name="setting_type"
            id="setting_type"
            value={stone.setting_type || ""}
            onChange={(e) => setStone({ ...stone, setting_type: e.target.value })}
            className="mt-1 block w-full input rounded-md border-gray-300 shadow-sm focus:ring-chabot-gold focus:border-chabot-gold"
          >
            <option value="">(none)</option>
            {stonePropertiesForm?.settingType?.map((opt, index) => (
              <option key={index} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700">
            Shape
          </label>
          <div className="mt-1 relative rounded-md shadow-sm">
            {/* <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <span className="text-gray-500 sm:text-sm">$</span>
                </div> */}
            <input
              type="text"
              value={stone.shape || ""}
              onChange={(e) => setStone({ ...stone, shape: e.target.value })}
              className="block w-full  rounded-md border-gray-300 input focus:ring-chabot-gold focus:border-chabot-gold"
            />
          </div>
        </div>
      </div>

      {/* <div>
            <label className="block text-sm font-medium text-gray-700">Notes</label>
            <textarea
              value={stone.notes}
              onChange={(e) => setStone({ ...stone, notes: e.target.value })}
              rows={2}
              placeholder="Optional notes about the stones"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:ring-chabot-gold focus:border-chabot-gold"
            />
          </div> */}

      <div className="flex justify-end space-x-3">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-md"
        >
          {isEditing ? "Save Stone" : "Add Stone"}
        </button>
      </div>
    </div>
  );
};

export default StoneForm;
