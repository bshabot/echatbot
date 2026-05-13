import DeleteButton from "./DeleteButton";
import { Download } from "lucide-react";
import { useState } from "react";
import ConfirmationModal from "../ConfirmationModal";
import { useMessage } from "../Messages/MessageContext";

export default function ViewableListActionButtons({
  isSelectionMode,
  setIsSelectionMode,
  handleExport,
  handleExportAll,
  handleSelections,
  allItems,
  selectedItems,
  onDelete,
  type,
  customComponent,
}) {
  const { showMessage } = useMessage();
  const [isSelectAll, setSelectAll] = useState(false);
  // const [isSelectionMode,setIsSelectionMode] = useState(false)

  const toggleSelectAll = () => {
    const nextSelectAll = !isSelectAll;
    setSelectAll(nextSelectAll);

    const currentPageItemIds = new Set(allItems);

    if (nextSelectAll) {
      // Select all items on the current page + preserve previous selections
      const newSelection = new Set([...selectedItems, ...currentPageItemIds]);
      setIsSelectionMode(true);
      handleSelections(newSelection);
    } else {
      // Deselect only the items on the current page
      const newSelection = new Set(
        [...selectedItems].filter((id) => !currentPageItemIds.has(id))
      );
      handleSelections(new Set(newSelection));
      setIsSelectionMode(newSelection.size > 0);
    }
  };

  const handleButtonSelections = () => {
    setIsSelectionMode(!isSelectionMode);
    // setSelectAll(!isSelectAll)
    if (!isSelectionMode) {
      setIsSelectionMode(true);
    } else {
      // if(!isSelectionMode){
      handleSelections(new Set());
      setIsSelectionMode(false);
      setSelectAll(false);
    }
  };

  const handleDelete = async (success) => {
    showMessage(
      success
        ? "Items have been deleted successfully"
        : "Error occured while deleting"
    );
    onDelete(Array.from(selectedItems));
    handleSelections(new Set());
  };

  return (
    <div className="flex justify-between mb-4 space-x-3">
      <div className="flex gap-2">
        <button
          onClick={handleButtonSelections}
          className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
        >
          {isSelectionMode ? "Cancel Selection" : `Select ${type === 'sample_with_stones_export' ? 'Samples' : type === 'ideas' ? 'Ideas' : type === 'designs' ? 'Designs' : type}`}
        </button>
        <button
          onClick={toggleSelectAll}
          className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-lg hover:bg-opacity-90 inline-flex items-center"
        >
          {isSelectAll ? "Deselect All" : "Select All"}
        </button>
      </div>

      <div className="flex justify-center items-center gap-2">
        {isSelectionMode && selectedItems.size > 0 && (
          <DeleteButton
            onDelete={handleDelete}
            type={type}
            selectedItems={selectedItems}
          />
        )}
        {isSelectionMode &&
          selectedItems.size > 0 &&
          (customComponent ? (
            // Render the custom component if provided
            customComponent
          ) : (
            // Render the default export button
            <button
              onClick={handleExport}
              className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-lg hover:bg-opacity-90 inline-flex items-center"
            >
              <Download className="w-4 h-4 mr-2" />
              Export Selected ({selectedItems.size})
            </button>
          ))}
        {!isSelectionMode && type === "Samples" && (
          <button
            onClick={handleExportAll}
            className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-lg hover:bg-opacity-90 inline-flex items-center"
          >
            <Download className="w-4 h-4 mr-2" />
            Export All
          </button>
        )}
      </div>
    </div>
    //    </>
  );
}
