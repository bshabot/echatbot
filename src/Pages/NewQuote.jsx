import { useSupabase } from "../components/SupaBaseProvider";
import React, { useState, useEffect, useRef } from "react";
import { Plus, Trash2 } from "lucide-react";
import { getImages } from "../components/SupaBaseProvider";
import CustomSelectWithSelections from "../components/CustomSelectWithSelections";
import { useNavigate } from "react-router-dom";
import { useMessage } from "../components/Messages/MessageContext";
import useFormUpdater from "../Hooks/UseFormUpdater";
import { getMetalCost } from "../components/Samples/CalculatePrice";
import { useMetalPriceStore } from "../store/MetalPrices";
import { getTotalCost } from "../components/Samples/TotalCost";
import { useLocation } from "react-router-dom";
import EditableCellWithGenerics from "../components/Qoutes/EditableCellWithGenerics";
import { useGenericStore } from "../store/VendorStore";
import CustomSelect from "../components/CustomSelect";
import Loading from "../components/Loading";
import useScanListener from "../Hooks/useScanListener";
import { findSampleByStyleNumber } from "../utils/tags/tagData";

export default function NewQuote() {
  const navigate = useNavigate();
  const location = useLocation();
  const allowedLineItemFields = [
    "id",
    "productId",
    "retailPrice",
    "internalNote",
    "margin",
    "totalCost",
    "salesPrice",
    "quoteNumber",
    "BuyerComment",
    // add any other fields that are valid in your lineItems table
  ];
  const { prices } = useMetalPriceStore();
  const { supabase, session } = useSupabase();

  const { showMessage } = useMessage();
  const [productInfo, setProductInfo] = useState([]);
  const [lineItems, setlineItems] = useState([]);
  const [lineItemsToDelete, setlineItemsToDelete] = useState([]);
  // Multi-select for bulk line deletion; keys are productId ?? sample_id
  const [selectedLines, setSelectedLines] = useState(new Set());
  const [savedBulkMargin, setSavedBulkMargin] = useState(0); // Store the DB value for display only

  const isInitialLoadRef = useRef(true);
  // Tracks the previous bulkMargin value so the bulkMargin useEffect can detect which line
  // items were "following" the old bulk vs. manually overridden (option B per 2026-05-14).
  const previousBulkMarginRef = useRef(undefined);

  const quote = new URLSearchParams(location.search).get("quote") || null;
  const userId = session?.user?.id; // User ID

  const { formData, updateFormField, resetForm } = useFormUpdater({
    buyer: null,
    tags: "",
    status: "Created:grey",
    agent: userId,
    gold: parseFloat(prices.gold.price),
    silver: parseFloat(prices.silver.price),
    multiplier: 4,
    bulkMargin: 0,
    quoteTotal: 0,
    // retailPrice: 0,
  });

  // normalize numeric/default fields for a line item (uses formData.bulkMargin)
  const normalizeLineItem = (item) => {
    const safeNum = (v, fallback = 0) =>
      Number(v === null || v === undefined || Number.isNaN(Number(v)) ? fallback : v);
    return {
      ...item,
      margin: safeNum(item.margin, formData?.bulkMargin ?? 0),
      totalCost: safeNum(item.totalCost, 0),
      salesPrice: safeNum(item.salesPrice, 0),
      retailPrice: safeNum(item.retailPrice, 0),
      bulkMargin: safeNum(item.bulkMargin, 0),
      weight: safeNum(item.weight, 0),
      salesWeight: safeNum(item.salesWeight, 0),
      internalNote: item.internalNote ?? "",
      BuyerComment: item.BuyerComment ?? "",
    };
  };

  const { getEntityItemById, getEntity } = useGenericStore();
  const vendors = getEntity("vendors");
  const [isLoading, setIsLoading] = useState(false);
  const [editingCell, setEditingCell] = useState(null);

  const [isOpen, setIsOpen] = useState(false);

  // Fetch quote and line items if quote param exists
 
useEffect(() => {
  if (quote) {
    console.log(quote, "quote from params");
    const fetchQuote = async () => {
      setIsLoading(true);
      try {
        const { data, error } = await supabase
          .from("quote_with_lineitems_and_product")
          .select("*")
          .eq("quoteNumber", quote)
          .single();

        console.log(data, "data from supabase");

        if (error) {
          console.error("Error fetching quote:", error);
          return;
        }

        // Process line items and fetch images
        const processedLineItems = await Promise.all(
          (data.lineitems || []).map(async (item) => {
            console.log(item, "line item before processing");
            const {
              product,
              internalNote,
              margin = 0,
              lineItemId,
              BuyerComment,
              bulkMargin,
            } = item;
            const {
              styleNumber,
              images,
              cad,
              sample_id,
              starting_description,
              weight,
              salesWeight,
            } = product || {};

            const vendor = getEntityItemById("vendors", product?.vendor);
            const lossPercentage = vendor?.pricingsetting?.lossPercentage || 0;
            // Use saved DB value when it's a real number; recompute when null/undefined/empty/NaN.
            // (?? only catches null/undefined; NaN and "" need their own check or they render as "NaN" / "Click to edit".)
            const useDbOrRecompute = (v, fallback) => {
              if (v === null || v === undefined || v === "") return fallback;
              return Number.isNaN(Number(v)) ? fallback : v;
            };
            const cost = useDbOrRecompute(item.totalCost, parseFloat(totalCost(product, lossPercentage).toFixed(2)) || 0);

            // Fall back to the QUOTE's saved bulkMargin (`data.bulkMargin`), not formData.bulkMargin.
            // formData hasn't been resetForm'd yet at this point — it still holds the initial state (0).
            const itemMargin = useDbOrRecompute(item.margin, data.bulkMargin || 0);

            const salesPrice = useDbOrRecompute(item.salesPrice, parseFloat((cost / (1 - itemMargin / 100)).toFixed(2)) || cost);

            const retailPrice = useDbOrRecompute(item.retailPrice, parseFloat((salesPrice * (formData.multiplier || 1)).toFixed(2)) || 0);

            // Back-derive salesPrice/margin when the DB has retailPrice saved correctly
            // but salesPrice and margin are 0 (stale snapshots from before earlier bug fixes).
            // Trust retailPrice as the customer-facing snapshot; recover the implied salesPrice + margin.
            const lineMultiplier = data.multiplier || formData.multiplier || 1;
            let finalSalesPrice = salesPrice;
            let finalMargin = itemMargin;
            if (
              Number(retailPrice) > 0 &&
              Number(cost) > 0 &&
              lineMultiplier > 0 &&
              Number(retailPrice) > Number(cost) * lineMultiplier &&
              (!Number(salesPrice) || Number(salesPrice) === 0)
            ) {
              finalSalesPrice = parseFloat((Number(retailPrice) / lineMultiplier).toFixed(2));
              if (!Number(itemMargin)) {
                finalMargin = parseFloat((((finalSalesPrice - Number(cost)) / finalSalesPrice) * 100).toFixed(2));
              }
            }

            return {
              ...product,
              productId: sample_id,
              description: starting_description || "",
              retailPrice,
              weight,
              salesWeight,
              internalNote: internalNote || "",
              margin: finalMargin,
              bulkMargin: bulkMargin || 0,
              totalCost: cost,
              salesPrice: finalSalesPrice,
              id: lineItemId,
              BuyerComment: BuyerComment || "",
            };
          })
        );

        console.log(processedLineItems, "processed line items");
        setlineItems(processedLineItems);

        // Keep bulkMargin in the data passed to resetForm.
        // If it gets stripped, formData.bulkMargin becomes undefined and the bulkMargin
        // useEffect downstream recomputes salesPrice as `cost / (1 - undefined/100)` = NaN,
        // wiping the hydrated values.
        const { lineitems, ...dataForForm } = data;

        setSavedBulkMargin(data.bulkMargin || 0);

        resetForm(dataForForm);

        setTimeout(() => {
          isInitialLoadRef.current = false;
        }, 0);
      } catch (err) {
        console.error("Unexpected error fetching quote:", err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchQuote();
  } else {
    isInitialLoadRef.current = false;
    console.log("not displaying a quote");
  }
}, [quote]);

  // Filter only allowed fields for DB insert/update
  const filterLineItemFields = (item) =>
    Object.fromEntries(
      Object.entries(item).filter(([key]) =>
        allowedLineItemFields.includes(key)
      )
    );

  // Handle form submit
  const handleSubmit = async (e) => {
    e.preventDefault();
    if (lineItems.length === 0) {
      showMessage("Please add items to the quote", "error");
      return;
    }
    const quoteTotal = lineItems.reduce((acc, item) => acc + item.totalCost, 0);
    const { lineItems: dontUse, ...rest } = formData;
    const submitForm = {
      ...rest,
      updated_at: new Date().toISOString(),
      quoteTotal: quoteTotal,
    };
    if (quote) {
      await updateIfChanged(submitForm);
      await updateLineItem();
      await updateIfLineItemsChanged();
      await handleLineItemsToDelete();
      showMessage("Quote Updated", "success");
      navigate("/quotes");
      return;
    }
    const { data, error } = await supabase
      .from("quotes")
      .insert([submitForm])
      .select()
      .single();

    if (error) {
      console.error(error);
    }
    showMessage("Quote Created", "success");
    const payload = lineItems.map((item) => ({
      ...filterLineItemFields(normalizeLineItem(item)),
      quoteNumber: data.quoteNumber,
    }));
    const { error: lineItemError } = await supabase.from("lineItems").insert(payload);
    if (lineItemError) {
      console.error(lineItemError);
    }
    navigate("/quotes");
  };

  // Update quote if changed
  const updateIfChanged = async (submitForm) => {
    const { data: currentData, error: fetchError } = await supabase
      .from("quotes")
      .select("*")
      .eq("quoteNumber", quote)
      .single();

    if (fetchError) {
      console.error("Error fetching current data:", fetchError);
      return;
    }

    // Find only the changed fields
    const changedFields = Object.keys(submitForm).reduce((acc, key) => {
      if (submitForm[key] !== currentData[key]) {
        acc[key] = submitForm[key];
      }
      return acc;
    }, {});

    if (Object.keys(changedFields).length === 0) {
      console.log("No changes detected, skipping update.");
      return;
    }

    // Update only if something changed
    const { data, error } = await supabase
      .from("quotes")
      .update(changedFields)
      .eq("quoteNumber", quote)
      .select();

    if (error) {
      console.error("Error updating:", error);
    } else {
      console.log("Updated row:", data);
    }
  };

  // Insert new line items if changed
  const updateIfLineItemsChanged = async () => {
    let newLineItems = lineItems.filter((lineItem) => !lineItem.id);
    console.log(newLineItems, "new line items");

    const payload = newLineItems.map((item) => ({
      ...filterLineItemFields(normalizeLineItem(item)),
      quoteNumber: quote,
    }));
    const { error } = await supabase.from("lineItems").insert(payload);

    if (error) {
      console.error(error);
    }
  };

  // Upsert (update) existing line items
  const updateLineItem = async () => {
    console.log(lineItems, "line items to update");
    let lineItemsToUpdate = lineItems
      .filter((lineItem) => lineItem.id)
      .map((item) => filterLineItemFields(normalizeLineItem(item)));

    const { error } = await supabase.from("lineItems").upsert(
      lineItemsToUpdate.map((item) => ({
        ...item,
        quoteNumber: quote,
      })),
      { onConflict: ["id"] }
    );

    if (error) {
      console.error(error);
    }
  };

  // Delete line items marked for deletion
  const handleLineItemsToDelete = async () => {
    if (lineItemsToDelete.length > 0) {
      const { error } = await supabase
        .from("lineItems")
        .delete()
        .in("id", lineItemsToDelete);

      if (error) {
        console.error("Error deleting line items:", error);
      }
    }
  };

  // Handle changes to a line item (margin, salesPrice, etc.)
  const handleLineChange = (productId, field, value) => {
    setlineItems((prevItems) =>
      prevItems.map((item) => {
        console.log(productId, field, value, "productId, field, value",(item.productId ?? item.sample_id) !== productId,'item.productId || item.sample_id!== productId');
        if ((item.productId ?? item.sample_id) !== productId) return item;
        const updatedItem = { ...item, [field]: value };

        // If margin was updated, calculate new salesPrice and retailPrice
        if (field === "margin") {
          const weight =
            productInfo.find((item) => item.productId === productId)?.weight ||
            0;
          const totalCost = parseFloat(item.totalCost.toFixed(2)) || 0;
          const margin = parseInt(value) || 0;
          const retailPrice =
            parseFloat((item.salesPrice * formData.multiplier).toFixed(2)) || 0;
          const salesPrice = parseFloat(
            +(totalCost / (1 - margin / 100)).toFixed(2)
          );

          console.log(
            +(totalCost / (1 - margin / 100)).toFixed(2),
            parseFloat(+(totalCost / (1 - margin / 100)).toFixed(2)),
            margin,
            "total cost after margin"
          );
          updatedItem.salesPrice = salesPrice;
          updatedItem.retailPrice = retailPrice;
        }
        // If salesPrice was updated, recalc margin
        if (field === "salesPrice") {
          const totalCost = parseFloat(item.totalCost.toFixed(2)) || 0;
          const salesPrice = parseFloat(value) || 0;
          updatedItem.margin = parseFloat(
            +(((salesPrice - totalCost) / salesPrice) * 100).toFixed(2)
          );
        }

        // Log updated item for debugging
        console.log(updatedItem, "updated item");
        return updatedItem;
      })
    );
  };

  // Handle selection of new products/items
  const handleCustomSelect = (items) => {
    items.forEach((element) => {
      const lossPercentage =
        getEntityItemById("vendors", element.vendor)?.pricingsetting
          ?.lossPercentage || 0;
      const cost =
        parseFloat(totalCost(element, lossPercentage).toFixed(2)) || 0;
      const salesPrice = cost;
      const retailPrice =
        parseFloat((salesPrice * (formData.multiplier || 1)).toFixed(2)) || 0;
      // Log cost and retail price for debugging
      console.log(cost, retailPrice, "cost and retail price");
    });

    const itemData = items.map((item) => {
      const lossPercentage =
        getEntityItemById("vendors", item.vendor)?.pricingsetting
          ?.lossPercentage || 0;
      const cost = parseFloat(totalCost(item, lossPercentage).toFixed(2)) || 0;
      const salesPrice = cost;
      const retailPrice =
        parseFloat((salesPrice * (formData.multiplier || 1)).toFixed(2)) || 0;
      // Log each item for debugging
      console.log(
        {
          ...item,
          productId: item.sample_id,
          retailPrice,
          internalNote: "",
          margin: formData.bulkMargin,
          totalCost: cost,
          salesPrice,
        },
        "item to add"
      );
      return {
        ...item,
        productId: item.sample_id,
        retailPrice,
        internalNote: "",
        margin: formData.bulkMargin,
        totalCost: cost,
        salesPrice,
      };
    });
    console.log(itemData, "item data to add");
    setlineItems((prev) => [...prev, ...itemData]);
  };

  // Scan-to-add: scanning a tag QR (the style number) adds that sample as a
  // line item through the same path as the Add Items modal, so costs, loss %,
  // margin and retail all compute identically. Duplicates are skipped with a
  // toast (per Brian's call: no quantity bump).
  useScanListener(async (code) => {
    try {
      const row = await findSampleByStyleNumber(supabase, code);
      if (!row) {
        showMessage(`No sample found for "${code}"`);
        return;
      }
      const already = lineItems.some(
        (li) => (li.productId ?? li.sample_id) === row.sample_id
      );
      if (already) {
        showMessage(`${row.styleNumber} is already on this quote`);
        return;
      }
      handleCustomSelect([row]);
      showMessage(`Added ${row.styleNumber} to quote`);
    } catch (err) {
      showMessage(err && err.message ? err.message : "Scan lookup failed");
    }
  });

  // Selection key for a line (saved lines have productId, fresh ones sample_id)
  const lineKey = (li) => li.productId ?? li.sample_id;

  const toggleLineSelection = (li) => {
    setSelectedLines((prev) => {
      const next = new Set(prev);
      const key = lineKey(li);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSelectAllLines = () => {
    setSelectedLines((prev) =>
      prev.size === lineItems.length
        ? new Set()
        : new Set(lineItems.map(lineKey))
    );
  };

  // Bulk delete: queue saved rows for DB deletion (same as deleteLineItem)
  // and drop all selected rows from the list.
  const deleteSelectedLines = () => {
    const dbIds = lineItems
      .filter((li) => selectedLines.has(lineKey(li)) && li.id)
      .map((li) => li.id);
    if (dbIds.length) setlineItemsToDelete((prev) => [...prev, ...dbIds]);
    setlineItems((prev) => prev.filter((li) => !selectedLines.has(lineKey(li))));
    setSelectedLines(new Set());
  };

  // Remove a line item from the list
  const deleteLineItem = (event, product) => {
    console.log(product?.id || product?.sample_id || "no id");
    event.preventDefault();
    product?.id
      ? setlineItemsToDelete((prevItems) => [...prevItems, product?.id])
      : "";
    setlineItems((prevItems) =>
      prevItems.filter((item) => item.productId !== product.productId)
    );
    // Keep the bulk-selection set in sync
    setSelectedLines((prev) => {
      if (!prev.has(lineKey(product))) return prev;
      const next = new Set(prev);
      next.delete(lineKey(product));
      return next;
    });
  };

  // Helper to safely convert to number
  const safeNumber = (val) => Number(val) || 0;

  // Calculate total cost for a product
  const totalCost = (product, lossPercentage) => {
    const metalPrice =
      product.metalType === "Gold"
        ? safeNumber(formData.gold)
        : product.metalType === "Silver" ? safeNumber(formData.silver) : 0;
    const weight = safeNumber(product.weight);
    const karat = product.karat;
    const loss = safeNumber(lossPercentage);
    const miscCost = safeNumber(product.miscCost);
    const laborCost = safeNumber(product.laborCost);

    if (product.metalType !== "Brass" && !metalPrice) {
      console.error("Metal price is missing!");
      return 0;
    }

    // Log all input values for debugging
    console.log(
      {
        metalPrice,
        weight,
        karat,
        loss,
        miscCost,
        laborCost,
        stones: product.stones,
      },
      "totalCost input values"
    );

    const metalCost = getMetalCost(metalPrice, weight, karat, loss);
    const totalCost = getTotalCost(
      metalCost,
      miscCost,
      laborCost,
      product.stones,
      product.platingCharge
    );
    // Log calculated costs for debugging
    console.log(metalCost, "metal cost", totalCost, "total cost calculated");
    return totalCost;
  };

  // Update totalCost and salesPrice when metal prices change
  useEffect(() => {
    // Skip on initial load so the hydration map can preserve saved DB values
    // (matches the guard pattern used by the bulkMargin + multiplier useEffects below)
    if (isInitialLoadRef.current) {
      return;
    }
    setlineItems((prevItems) =>
      prevItems.map((item) => {

        const vendor = getEntityItemById("vendors", item.vendor);
        const lossPercentage = vendor?.pricingsetting?.lossPercentage || 0;

        const oldCost = item.totalCost || 0;
        const newCost = parseFloat(
          totalCost(item, lossPercentage).toFixed(2)
        );

        // Use the item's existing margin to calculate new sales price
        const itemMargin = item.margin ?? 0;
        const newSalesPrice = parseFloat(
          (newCost / (1 - itemMargin / 100)).toFixed(2)
        );

        // Log recalculated values
        console.log(
          {
            oldCost,
            newCost,
            itemMargin,
            newSalesPrice,
          },
          "recalculated line item values for metal price change"
        );

        return {
          ...item,
          totalCost: newCost,
          salesPrice: newSalesPrice,
          // Keep the existing margin, don't recalculate it
        };
      })
    );
  }, [formData.gold, formData.silver]);

  // BulkMargin change: option B per Brian 2026-05-14.
  // Only update line items that were FOLLOWING the previous bulkMargin (i.e., their per-item
  // margin still equals the old bulk value). Items where the user has set a different per-item
  // margin are preserved — bulkMargin is treated as a default, not an override.
  useEffect(() => {
    // Skip on initial load — and seed the ref so subsequent changes have a baseline.
    if (isInitialLoadRef.current) {
      previousBulkMarginRef.current = formData.bulkMargin;
      return;
    }
    // Skip when bulkMargin is not a real number (transient state during quote load).
    if (formData.bulkMargin === undefined || formData.bulkMargin === null || Number.isNaN(Number(formData.bulkMargin))) {
      return;
    }
    const oldBulk = previousBulkMarginRef.current;
    previousBulkMarginRef.current = formData.bulkMargin;
    // No-op if value didn't actually change.
    if (Number(oldBulk) === Number(formData.bulkMargin)) return;

    setlineItems((prevItems) =>
      prevItems.map((item) => {
        // Preserve per-item margin if it differs from the old bulk (user-overridden).
        // Only update items that were tracking the old bulk value.
        const itemMarginNum = Number(item.margin);
        const oldBulkNum = Number(oldBulk);
        if (!Number.isNaN(itemMarginNum) && itemMarginNum !== oldBulkNum) {
          return item;
        }
        const itemMargin = formData.bulkMargin;
        const lineCost = parseFloat((item.totalCost || 0).toFixed(2)) || 0;
        const newSalesPrice = parseFloat(
          +(lineCost / (1 - itemMargin / 100)).toFixed(2)
        );
        return {
          ...item,
          salesPrice: newSalesPrice,
          margin: itemMargin,
        };
      })
    );
  }, [formData.bulkMargin]);
  // Update retailPrice when multiplier changes
  useEffect(() => {
    // Skip on initial load
    if (isInitialLoadRef.current) {
      return;
    }
    
    setlineItems((prevItems) =>
      prevItems.map((item) => {
        const newRetailPrice = parseFloat(
          (item.salesPrice * (formData.multiplier || 1)).toFixed(2)
        );

        console.log(
          {
            salesPrice: item.salesPrice,
            multiplier: formData.multiplier,
            newRetailPrice,
          },
          "recalculated retailPrice for multiplier change"
        );

        return {
          ...item,
          retailPrice: newRetailPrice,
        };
      })
    );
  }, [formData.multiplier]);
  // Log productInfo and lineItems for debugging
  console.log(productInfo, lineItems, "line items");

  return (
    <div className="flex flex-col min-h-[80vh]">
      <div className="p-6 flex-1 flex flex-col">
        {/* headers for the new quote page */}
        <div className="flex flex-wrap gap-2 items-center">
          <h1 className="text-2xl font-bold text-gray-900">
            {quote ? "Update Quote" : "Create Quote"}
          </h1>
          {/* this div supplies the user with a add and selection modal */}
          <div className="flex space-x-3 justify-self-end flex-col w-48 ml-auto">
            <button
              className="bg-chabot-gold text-white px-4 py-2 rounded-lg flex items-center hover:bg-opacity-90 transition-colors"
              onClick={() => setIsOpen(true)}
            >
              <Plus className="w-5 h-5 mr-2" />
              Add Items
            </button>
            <CustomSelectWithSelections
              version="sample_with_stones_export"
              selected={lineItems}
              close={() => setIsOpen(false)}
              onSelect={handleCustomSelect}
              isOpen={isOpen}
            />
          </div>
        </div>

        <div className="flex flex-col justify-between items-end  mb-6 flex-1 h-full  ">
          <div className="flex flex-wrap gap-2 mt-4 w-full justify-between">
            {/* metalPrices */}
            <div className="flex gap-2">
              <div className="flex flex-col mb-1">
                <label htmlFor="gold_price">Gold Price</label>
                <input
                  type="number"
                  className="block input shadow-sm focus:border-blue-500 focus:ring-blue-500 flex-1"
                  name="gold"
                  id="gold_price"
                  placeholder="2300"
                  value={formData.gold}
                  onChange={(e) =>
                    updateFormField("gold", parseFloat(e.target.value))
                  }
                />
              </div>
              <div className="flex flex-col mb-1">
                <label htmlFor="silver_price">Silver Price</label>
                <input
                  type="number"
                  className="block input shadow-sm focus:border-blue-500 focus:ring-blue-500 flex-1"
                  name="silver"
                  id="silver_price"
                  placeholder="32"
                  value={formData.silver}
                  onChange={(e) =>
                    updateFormField("silver", parseFloat(e.target.value))
                  }
                />
              </div>
            </div>
            <div className="flex gap-2">
              {/* bulk margins */}
              <div>
                <label htmlFor="bulk-margin">Bulk Margin</label>
                <input
                  type="number"
                  className="block input shadow-sm focus:border-blue-500 focus:ring-blue-500 flex-1"
                  name="bulk-margin"
                  id="bulk-margin"
                  placeholder={savedBulkMargin ? `${savedBulkMargin}` : "0"}
                  onChange={(e) =>
                    updateFormField("bulkMargin", parseFloat(e.target.value))
                  }
                  value={ formData.bulkMargin || savedBulkMargin }
                />
              </div>
              {/* retail price multipler */}
              <div>
                <label htmlFor="multiplier">Multipler</label>
                <input
                  type="number"
                  step="0.01"
                  className="block input shadow-sm focus:border-blue-500 focus:ring-blue-500 flex-1"
                  name="multiplier"
                  id="multiplier"
                  onChange={(e) =>
                    updateFormField("multiplier", parseFloat(e.target.value))
                  }
                  value={formData.multiplier}
                />
              </div>
            </div>
          </div>

          <form
            onSubmit={handleSubmit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
              }
            }}
            className="p-6 flex flex-col flex-1 h-full max-md:p-2"
          >
            {selectedLines.size > 0 && (
              <div className="flex justify-end mb-2">
                <button
                  type="button"
                  onClick={deleteSelectedLines}
                  className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 inline-flex items-center"
                >
                  <Trash2 className="w-4 h-4 mr-2" />
                  Delete Selected ({selectedLines.size})
                </button>
              </div>
            )}
            <div className="flex flex-1 h-full">
              <div className="overflow-auto h-full border border-gray-300 flex-1">
                <table className="w-full min-w-max min-h-full border-collapse border border-gray-300 flex-1">
                  <thead className="bg-gray-200 sticky top-0 z-10">
                    <tr className="bg-gray-200">
                      <th className="border border-gray-300 p-2 w-10">
                        <input
                          type="checkbox"
                          className="max-md:w-5 max-md:h-5"
                          aria-label="Select all line items"
                          checked={lineItems.length > 0 && selectedLines.size === lineItems.length}
                          onChange={toggleSelectAllLines}
                        />
                      </th>
                      <th className="border border-gray-300 p-2 w-20">Item</th>
                      <th className="border border-gray-300 p-2 w-20">Image</th>
                      <th className="border border-gray-300 p-2 w-20">
                        Description
                      </th>
                      <th className="border border-gray-300 p-2 w-20">
                        Weights
                      </th>
                      <th className="border border-gray-300 p-2 w-20">
                        Total Cost
                      </th>
                      <th className="border border-gray-300 p-2 w-20">
                        Margins
                      </th>
                      <th className="border border-gray-300 p-2 w-20">
                        Sales Price
                      </th>
                      <th className="border border-gray-300 p-2 w-20">
                        Retail Price
                      </th>
                      <th className="border border-gray-300 p-2 w-20">
                        Internal Note
                      </th>
                      <th className="border border-gray-300 p-2 w-20">
                        Buyer Comment
                      </th>
                      <th className="border border-gray-300 p-2 w-20">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {isLoading && <Loading />}
                    {lineItems && !isLoading && lineItems.map((product, index) => {
                      console.log(product, "product in lineItems");
                      // let product = product;
                      return (
                        <tr key={index} className="h-32">
                            <td className="border border-gray-300 p-2 text-center align-middle">
                              <input
                                type="checkbox"
                                className="max-md:w-5 max-md:h-5"
                                aria-label={`Select ${product.styleNumber || "line item"}`}
                                checked={selectedLines.has(product.productId ?? product.sample_id)}
                                onChange={() => toggleLineSelection(product)}
                              />
                            </td>
                            <td className="border border-gray-300 p-2 text-center">
                              {(product.sample_id || product.productId) ? (
                                <a
                                  href={`/samples?sampleId=${product.sample_id || product.productId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:text-blue-800 underline"
                                >
                                  {product.styleNumber || productInfo.name}
                                </a>
                              ) : (
                                product.styleNumber || productInfo.name
                              )}
                            </td>
                            <td className="border border-gray-300 p-2 text-center">
                              <img
                                src={`${process.env.VITE_DB_HOST_URL}${product.images[0]}`}
                                alt={product.styleNumber}
                              />
                            </td>
                            <td className="border border-gray-300 p-2 text-center">
                              {product.description}
                            </td>
                            <td className="border border-gray-300 p-2 text-center">
                              <div className="flex flex-row items-center justify-center gap-2">
                                <div className="flex flex-col">
                                  <span>{product.weight}g</span>{" "}
                                  <span>w</span>
                                </div>
                                <div className="flex flex-col">
                                  <span>{product.salesWeight}g</span>{" "}
                                  <span>sw</span>
                                </div>
                              </div>
                            </td>
                            <td className="border border-gray-300 p-2 text-center">
                              ${product.totalCost}
                            </td>
                            <td className="border border-gray-300 p-2 text-center">
                              <input
                                type="number"
                                inputMode="numeric"
                                value={product.margin || 0}
                                onChange={(e) => {
                                  e.preventDefault();
                                  handleLineChange(
                                    product.productId || product.sample_id,
                                    "margin",
                                    parseInt(e.target.value)
                                  );
                                }}
                                className="input w-full text-center border-none outline-none"
                              />
                              <span className="ml-1">%</span>
                            </td>
                            <EditableCellWithGenerics
                              handleChange={handleLineChange}
                              setEditingCell={setEditingCell}
                              editingCell={editingCell}
                              id={product.productId}
                              cellType={"salesPrice"}
                              data={product.salesPrice}
                            />
                            <EditableCellWithGenerics
                              handleChange={handleLineChange}
                              setEditingCell={setEditingCell}
                              editingCell={editingCell}
                              id={product.productId}
                              cellType={"retailPrice"}
                              data={product.retailPrice}
                            />
                            <EditableCellWithGenerics
                              handleChange={handleLineChange}
                              setEditingCell={setEditingCell}
                              editingCell={editingCell}
                              id={product.productId || product.sample_id}
                              cellType={"internalNote"}
                              data={product.internalNote}
                            />
                            <td className="border border-gray-300 p-2 text-center  ">
                              {product.BuyerComment}
                            </td>
                            <td className="border border-gray-300 p-2 text-center align-middle">
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.preventDefault();
                                  deleteLineItem(event, product);
                                }}
                                className="inline-flex items-center justify-center p-2 bg-red-500 text-white rounded-md hover:bg-red-600"
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    {/* Ghost row: click to pick items from the Add Items
                        modal — or just scan a tag to add it directly */}
                    {!isLoading && (
                      <tr
                        className="h-14 cursor-pointer text-gray-400 hover:bg-gray-50 hover:text-gray-600"
                        onClick={() => setIsOpen(true)}
                      >
                        <td colSpan={12} className="border border-dashed border-gray-300 p-2 text-center">
                          <span className="inline-flex items-center gap-1.5 text-sm">
                            <Plus className="w-4 h-4" />
                            Add item — click to pick, or scan a tag
                          </span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap w-full justify-between self-end gap-2">
              <div className="flex flex-row mb-1 gap-2 flex-wrap">
                <div className="flex flex-col mb-1">
                  <label htmlFor="reference">Reference</label>
                  <input
                    type="text"
                    className="block input shadow-sm focus:border-blue-500 focus:ring-blue-500 flex-1"
                    name="reference"
                    id="reference"
                    placeholder="Customer Ref / Labels"
                    value={formData.tags}
                    onChange={(e) => updateFormField("tags", e.target.value)}
                  />
                </div>
                <div className="flex flex-col mb-1">
                  <label htmlFor="buyer">Prepared For</label>
                  <CustomSelect
                    onSelect={(option) => {
                      const { categories, value } = option;
                      updateFormField("buyer", value);
                    }}
                    version={"customers"}
                    hidden={false}
                    informationFromDataBase={formData.buyer}
                  />
                </div>
              </div>

              <div className="mt-6 flex justify-self-end space-x-3">
                <button
                  type="button"
                  className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 border border-gray-300 rounded-md"
                  onClick={() => navigate("/quotes")}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-chabot-gold hover:bg-opacity-90 rounded-md"
                >
                  {quote ? "Update Quote" : "Create Quote"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ensure numeric defaults for line item fields
const normalizeLineItem = (item) => {
  const safeNum = (v, fallback = 0) =>
    Number(v === null || v === undefined || Number.isNaN(Number(v)) ? fallback : v);
  return {
    ...item,
    margin: safeNum(item.margin, formData?.bulkMargin ?? 0),
    totalCost: safeNum(item.totalCost, 0),
    salesPrice: safeNum(item.salesPrice, 0),
    retailPrice: safeNum(item.retailPrice, 0),
    bulkMargin: safeNum(item.bulkMargin, 0),
    weight: safeNum(item.weight, 0),
    salesWeight: safeNum(item.salesWeight, 0),
    internalNote: item.internalNote ?? "",
    BuyerComment: item.BuyerComment ?? "",
  };
};
