import React, { useState, useRef, useEffect } from "react";
import { Link } from "lucide-react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faFilePdf, faFileExcel } from "@fortawesome/free-solid-svg-icons";
import EditableCell from "./EditableCell";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useSupabase } from "../SupaBaseProvider";
import QuotePDFGenerator from "../Pdf/QuotePDFGenerator";
import { exportToCsv, exportToExcel } from "../../utils/exportOrderToExcel";
import Pagination from "../MiscComponenets/Pagination";
const GridComponent = ({ quotes, setQuotes, selected,setSelected}) => {
  const navigate = useNavigate();
  const { supabase } = useSupabase();
  const [editingCell, setEditingCell] = useState(null);
  // const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [totalPages, setTotalPages] = useState(null);
  const [copiedRowId, setCopiedRowId] = useState(null); // State to track which row was copied
  const [rowType, setRowType] = useState(null); // State to track the type of row copied
  // const hasFetchedQuotes = useRef(false);
   const [searchParams, setSearchParams] = useSearchParams(); // React Router hook for query params
  const page = parseInt(searchParams.get("page") || "0", 10);
  const buyer = searchParams.getAll('customer') || ""; // Get the buyer filter from the URL


  useEffect(() => {
    // if (!hasFetchedQuotes.current) {
      fetchQuotes(page); // Fetch quotes only once
      // hasFetchedQuotes.current = true;
    // }
  }, [page,searchParams]);

  // Handle cell value change
  const handleChange = (rowId, field, value) => {
    const { data, error } = supabase
      .from("quotes")
      .update({ [field]: value })
      .eq("id", rowId);

    if (error) {
      console.error("Error updating quote:", error);
    }
    // console.log(rowId,field,value,'rowId,field,value')
    const updatedData = [...quotes];
    const index = updatedData.findIndex((item) => item.id === rowId);
    // console.log(updatedData,'updated data')

    updatedData[index][field] = value;
    setQuotes(updatedData);
  };
  const handleExportToExcel = async (quoteNumber, quoteId) => {
    const { data, error } = await supabase
      .from("quote_with_lineitems_and_product")
      .select(
        '*'
      )
      .eq("quoteNumber", quoteNumber)
      .single();

    if (error) {
      console.error("Error fetching quote for Excel export:", error);
      return;
    }
    const lineItems = data.lineitems || [];
    // const processedLineItems = data.map((item) => {
    //   console.log(item);
    //   const { starting_info, ...productData } = item.product; // Extract startingInfo and product data
    //   const { id, ...startingInfoData } = starting_info; // Extract id and other properties from startingInfo
    //   return {
    //     ...productData, // Spread the product data into the top-level object
    //     ...startingInfoData, // Spread the startingInfo data into the top-level object
    //   };
    // });
    console.log(lineItems, "sample data");
    exportToExcel(lineItems, `Quote_${quoteId}`);
  };

  const handleEditQuote = (quoteNumber) => {
    navigate(`/newQuote?quote=${quoteNumber}`);
  };
 
  const PAGE_SIZE = 20;

  const handleCopyToClipboard = (quoteNumber, rowId) => {
    navigator.clipboard.writeText(
      `${window.location.origin}/viewQuote?quote=${quoteNumber}`
    );
    setRowType("link");
    setCopiedRowId(rowId); // Set the copied row ID
    setTimeout(() => setCopiedRowId(null), 2000); // Reset after 2 seconds
  };

  const fetchQuotes = async () => {
    setLoading(true);
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    
    let query = supabase
      .from("quotes")
      .select(`
        *,
        buyer (
          id,
          name
        )
      `, { count: "exact" })
      .order("created_at", { ascending: false }) // or by ID
      .range(from, to);

    if (buyer.length > 0 && buyer) {
      query = query.in("buyer", buyer);
    }
    const { data, error, count } = await query;

    if (error) {
      console.error("Error fetching quotes:", error);
      setLoading(false);
      return;
    }

    setHasMore(data.length === PAGE_SIZE);
    if (count != null) setTotalPages(Math.max(1, Math.ceil(count / PAGE_SIZE)));

    setQuotes([ ...data]);
    // setPage(pageNumber + 1);
    setLoading(false);
  };

  
  const handleSelectAll = () => {
    if (selected.size === quotes.length) {
      // Deselect all rows
      setSelected(new Set());
    } else {
      // Select all rows
      const allRowIds = new Set(quotes.map((quote) => quote.id));
      setSelected(allRowIds);
    }
  };
  const handleRowSelection = (rowId) => {
    setSelected((prevSelectedRows) => {
      const newSelectedRows = new Set(prevSelectedRows);
      if (newSelectedRows.has(rowId)) {
        newSelectedRows.delete(rowId); // Deselect the row
      } else {
        newSelectedRows.add(rowId); // Select the row
      }
      return newSelectedRows;
    });
  };

  return (
      <Pagination loading={loading} hasMore={hasMore} totalPages={totalPages}>

    <div
      className="overflow-auto max-h-[600px] border border-gray-300"
      // onScroll={(e) => {
      //   const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
      //   const nearBottom = scrollHeight - scrollTop <= clientHeight + 50;

      //   if (nearBottom && !loading && hasMore) {
      //     fetchQuotes(page);
      //   }
      // }}
    >

      <table className="w-full border-collapse border border-gray-300 table-sticky">
        <thead className="bg-gray-200 sticky top-0 z-10">
          <tr className="bg-gray-200">
            <th className="border border-gray-300 p-2 w-20">
              <input type="checkbox" className="w-5 h-5"  
              checked={selected.size === quotes.length} onChange={handleSelectAll} />
            </th>
            <th className="border border-gray-300 p-2 w-20">Quote Date</th>
            <th className="border border-gray-300 p-2 w-20">Quote Number</th>
            <th className="border border-gray-300 p-2 w-20">Quote Total</th>
            {/* <th className="border border-gray-300 p-2 w-20">Prepared By</th> */}
            <th className="border border-gray-300 p-2 w-20">For</th>
            <th className="border border-gray-300 p-2 w-20">
              Customer Ref / Labels
            </th>
            <th className="border border-gray-300 p-2 w-20">Status</th>
            <th className="border border-gray-300 p-2 w-20">Actions</th>
          </tr>
        </thead>
        <tbody>
          {quotes.map((row, index) => {
            return (
              <tr key={index}>
                <td className="text-center border border-gray-300">
                  <input type="checkbox" className="w-5 h-5"  onChange={() => handleRowSelection(row.id)}
                    checked={selected.has(row.id)}/>
                </td>
                <td className="border border-gray-300 p-2 text-center">
                  <span className="flex flex-col">
                    {new Date(row.created_at).toLocaleDateString()}
                    <div className="flex flex-row  gap-2">
                      <button
                        onClick={() => handleEditQuote(row.quoteNumber)}
                        className="flex-1 bg-green-500 text-white px-2 py-1 rounded-md text-sm"
                      >
                        Edit/View{" "}
                      </button>
                      {/* <button onClick={()=> handleViewQuote(row.quoteNumber)} className="flex-1 bg-green-500 text-white px-2 py-1 rounded-md text-sm">View </button> */}
                    </div>
                  </span>
                </td>
                <td className="border border-gray-300 p-2 text-center">
                  {row.id}
                </td>
                <td className="border border-gray-300 p-2 text-center">
                  ${row.quoteTotal}
                </td>
                {/* <td className="border border-gray-300 p-2 text-center">
                  {row.agent}
                </td> */}
                <td className="border border-gray-300 p-2 text-center">
                  {row.buyer?.name}
                </td>
                <EditableCell
                  handleChange={handleChange}
                  setEditingCell={setEditingCell}
                  editingCell={editingCell}
                  row={row}
                  index={index}
                  cellType={"tags"}
                />
                <EditableCell
                  handleChange={handleChange}
                  setEditingCell={setEditingCell}
                  editingCell={editingCell}
                  row={row}
                  index={index}
                  cellType={"status"}
                />
                <td className="border border-gray-300 p-2 text-center">
                  <div className="flex w-full h-full justify-around">
                    <div className="relative group z-10">
                      {/* Label for Copy to Clipboard */}
                      {copiedRowId === row.id && rowType === "link" ? (
                        <label
                          htmlFor=""
                          className="absolute z-40 bottom-full mb-1 left-1/2 transform -translate-x-1/2 text-xs text-gray-600 bg-white px-2 py-1 rounded-md shadow-md"
                        >
                          Copied to clipboard
                        </label>
                      ) : (
                        <label
                          htmlFor=""
                          className="absolute z-40 bottom-full mb-1 left-1/2 transform -translate-x-1/2 text-xs text-gray-600 bg-white px-2 py-1 rounded-md hidden group-hover:block"
                        >
                          Copy to clipboard
                        </label>
                      )}
                      {/* Clickable Icon */}
                      <div
                        onClick={() =>
                          handleCopyToClipboard(row.quoteNumber, row.id)
                        }
                        className="cursor-pointer z-0"
                        aria-label="Copy link to clipboard"
                      >
                        <Link className="text-black hover:text-blue-700" />
                      </div>
                    </div>
                    <div
                      onClick={() => {
                        setCopiedRowId(row.id); // Set the copied row ID
                        setRowType("pdf");
                        setTimeout(() => {
                          setCopiedRowId(null);
                          setRowType(null);
                        }, 2000);
                      }}
                      className="cursor-pointer"
                    >
                      {/* <FontAwesomeIcon icon={faFilePdf} size="lg" /> */}
                      <div className="relative group z-10">
                        {copiedRowId === row.id && rowType === "pdf" ? (
                          <label
                            htmlFor=""
                            className="absolute z-40 bottom-full mb-1 left-1/2 transform -translate-x-1/2 text-xs text-gray-600 bg-white px-2 py-1 rounded-md shadow-md"
                          >
                            Downloading PDF...
                          </label>
                        ) : (
                          <label
                            htmlFor=""
                            className="absolute z-40 bottom-full mb-1 left-1/2 transform -translate-x-1/2 text-xs text-gray-600 bg-white px-2 py-1 rounded-md hidden group-hover:block"
                          >
                            Download PDF
                          </label>
                        )}
                        <QuotePDFGenerator
                          quoteId={row.id}
                          quoteNumber={row.quoteNumber}
                        />
                      </div>
                    </div>
                    <div
                      onClick={() => {
                        setCopiedRowId(row.id); // Set the copied row ID
                        setRowType("excel");
                        setTimeout(() => {
                          setCopiedRowId(null);
                          setRowType(null);
                        }, 2000);
                        handleExportToExcel(row.quoteNumber, row.id);
                      }}
                      className="cursor-pointer"
                    >
                      <div className="relative group z-10">
                        {copiedRowId === row.id && rowType === "excel" ? (
                          <label
                            htmlFor=""
                            className="absolute z-40 bottom-full mb-1 left-1/2 transform -translate-x-1/2 text-xs text-gray-600 bg-white px-2 py-1 rounded-md shadow-md"
                          >
                            Downloading Excel...
                          </label>
                        ) : (
                          <label
                            htmlFor=""
                            className="absolute z-40 bottom-full mb-1 left-1/2 transform -translate-x-1/2 text-xs text-gray-600 bg-white px-2 py-1 rounded-md hidden group-hover:block"
                          >
                            Export to Excel
                          </label>
                        )}
                        <FontAwesomeIcon
                          icon={faFileExcel}
                          size="lg"
                          className="hover:text-blue-700"
                        />
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

    </div>
      </Pagination>
  );
};

export default GridComponent;
