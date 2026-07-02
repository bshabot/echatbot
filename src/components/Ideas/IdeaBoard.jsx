import React, { useState, useEffect } from "react";
import Loading from "../Loading";

import { Download } from "lucide-react";
import { useSupabase } from "../SupaBaseProvider";
import ViewableListActionButtons from "../MiscComponenets/ViewableListActionButtons";
import IdeasExportButton from "../Pdf/IdeasExportButton";
import IdeaCard from "./IdeaCard";
import { useSearchParams } from "react-router-dom";

const IdeaBoard = ({ ideas, setIdeas, isLoading, setIsLoading, hasMore, setHasMore, setTotalPages, handleClick }) => {
  const [selectedIdeas, setSelectedIdeas] = useState(new Set());
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const { supabase } = useSupabase();
  const PAGE_SIZE = 20;

  const [searchParams, setSearchParams] = useSearchParams(); // React Router hook for query params
  const page = parseInt(searchParams.get("page") || "0", 10); // Get the current page from the URL

  // Fetch ideas from Supabase
  const fetchIdeas = async (pageNumber) => {
    setIsLoading(true);
    const from = pageNumber * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error, count } = await supabase
      .from("ideas")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) {
      console.error("Error fetching ideas:", error);
      setIsLoading(false);
      return;
    }

    setIdeas(data); // Replace ideas with the current page's data
    setHasMore(data.length === PAGE_SIZE); // Check if there are more pages
    if (setTotalPages && count != null) setTotalPages(Math.max(1, Math.ceil(count / PAGE_SIZE)));
    setIsLoading(false);
  };

  // Fetch the current page on component mount or when the page changes
  useEffect(() => {
    fetchIdeas(page);
  }, [page]);

  // Handle page navigation
  

  const handleExport = async () => {
    const ideasToExport = ideas.filter((p) => selectedIdeas.has(p.id));
    const { data: ideasData, error: ideasDataError } = await supabase
      .from("ideas")
      .select("*")
      .in("id", ideasToExport.map((idea) => idea.id));

    if (ideasDataError) {
      console.error("Error exporting ideas:", ideasDataError);
      return;
    }

    setSelectedIdeas(new Set());
    setIsSelectionMode(false);
  };

  const toggleIdeaSelection = (idea) => {
    const newSelection = new Set(selectedIdeas);
    if (newSelection.has(idea.id)) {
      newSelection.delete(idea.id);
    } else {
      newSelection.add(idea.id);
    }
    setSelectedIdeas(newSelection);
  };

    if(isLoading){
      return <Loading />
    }
  return (
    <div>
      <ViewableListActionButtons
        isSelectionMode={isSelectionMode}
        setIsSelectionMode={setIsSelectionMode}
        handleSelections={(selected) => setSelectedIdeas(selected)}
        handleExport={handleExport}
        allItems={ideas.map((i) => i.id)}
        selectedItems={selectedIdeas}
        onDelete={(deletedSelectedItems) =>
          setIdeas(ideas.filter((i) => !deletedSelectedItems.includes(i.id)))
        }
        type="ideas"
        customComponent={
          <IdeasExportButton
            ideas={selectedIdeas}
            fetchIdeas={async () => {
              const ideasToExport = ideas.filter((p) => selectedIdeas.has(p.id));
              const { data: ideasData, error: ideasDataError } = await supabase
                .from("ideas")
                .select("*")
                .in("id", ideasToExport.map((idea) => idea.id));

              if (ideasDataError) {
                console.error("Error exporting ideas:", ideasDataError);
                return [];
              }

              return ideasData; // Return the fetched data
            }}
            setSelectedIdeas={setSelectedIdeas}
            setIsSelectionMode={setIsSelectionMode}
          >
            {(handleExport) => (
              <button
                onClick={handleExport}
                className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold rounded-lg hover:bg-opacity-90 inline-flex items-center"
              >
                <Download className="w-4 h-4 mr-2" />
                Export Selected ({selectedIdeas.size})
              </button>
            )}
          </IdeasExportButton>
        }
      />
      <div className="flex flex-col">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...ideas]
            .sort((a, b) => b.id - a.id)
            .map((idea) => (
              <IdeaCard
                key={idea.id}
                idea={idea}
                onClick={isSelectionMode ? toggleIdeaSelection : handleClick}
                selected={selectedIdeas.has(idea.id)}
                selectable={isSelectionMode}
              />
            ))}
        </div>
      </div>
    </div>
  );
};

export default IdeaBoard;
