import DeleteButton from "./DeleteButton";
import { Download } from "lucide-react";
import { useState } from "react";
import ConfirmationModal from "../ConfirmationModal";
import { useMessage } from "../Messages/MessageContext";
import ActionMenu from "./ActionMenu";
import useEscapeKey from "../../Hooks/useEscapeKey";

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
  extraSelectedActions,
  // Descriptors for the per-list bulk actions. When present they're folded
  // into a single "Actions" dropdown together with Export Selected, so the
  // bar stays two buttons wide no matter how many actions a list has. Lists
  // that don't pass this keep the old inline Export button.
  selectedActions,
  // How many things the selection counts as, when that differs from the
  // number of ids (e.g. a linked set is selected as 2-3 sample ids but is
  // ONE card, so 3 sets read "3", not 7). Defaults to the id count.
  selectedCount,
}) {
  const { showMessage } = useMessage();
  const shownCount = selectedCount ?? selectedItems.size;
  const [isSelectAll, setSelectAll] = useState(false);
  // Esc leaves selection mode and clears the picks (same as Cancel Selection).
  useEscapeKey(() => {
    handleSelections(new Set());
    setIsSelectionMode(false);
    setSelectAll(false);
  }, isSelectionMode);
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

  // Export Selected leads the menu when this list has one; a list that renders
  // its own export (customComponent) keeps that button and only the extra
  // actions go in the dropdown.
  const extraActions = (selectedActions || []).filter(Boolean);
  const menuItems = [
    !customComponent && {
      key: "export",
      label: `Export Selected (${shownCount})`,
      icon: Download,
      onClick: handleExport,
      description: "Download the selected rows as a spreadsheet",
    },
    ...extraActions,
  ].filter(Boolean);
  const hasActionMenu = extraActions.length > 0;

  return (
    <div className="flex justify-between mb-4 space-x-3 max-md:flex-wrap max-md:gap-2 max-md:space-x-0">
      <div className="flex gap-2 max-md:flex-wrap">
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
        {isSelectionMode && (
          <span
            aria-live="polite"
            className={`self-center text-[13px] font-medium px-2.5 py-1 rounded-full ${
              selectedItems.size > 0
                ? "bg-[#C5A572]/15 text-[#8a6d3b]"
                : "bg-gray-100 text-gray-500"
            }`}
          >
            {selectedItems.size > 0
              ? `${selectedItems.size} selected`
              : "Click items to select · Esc to cancel"}
          </span>
        )}
      </div>

      <div className="flex justify-center items-center gap-2 max-md:flex-wrap">
        {isSelectionMode && selectedItems.size > 0 && (
          <DeleteButton
            onDelete={handleDelete}
            type={type}
            selectedItems={selectedItems}
          />
        )}
        {isSelectionMode && selectedItems.size > 0 && hasActionMenu ? (
          <>
            {customComponent}
            <ActionMenu count={shownCount} items={menuItems} />
          </>
        ) : (
          <>
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
                  Export Selected ({shownCount})
                </button>
              ))}
            {isSelectionMode && selectedItems.size > 0 && extraSelectedActions}
          </>
        )}
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
