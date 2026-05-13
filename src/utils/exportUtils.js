
const stoneHeaders = Array.from({ length: 10 }, (_, i) => {
  const index = i + 1;
  return [
    { key: `stone${index}_id`, label: `Stone ${index} ID` },
    { key: `stone${index}_type`, label: `Stone ${index} Type` },
    // { key: `stone${index}_customType`, label: `Stone ${index} Custom Type` },
    { key: `stone${index}_color`, label: `Stone ${index} Color` },
    { key: `stone${index}_shape`, label: `Stone ${index} Shape` },
    { key: `stone${index}_size`, label: `Stone ${index} Size` },
    { key: `stone${index}_quantity`, label: `Stone ${index} Quantity` },
    { key: `stone${index}_cost`, label: `Stone ${index} Cost` },
    { key: `stone${index}_notes`, label: `Stone ${index} Notes` },
  ];
}).flat();
const startingInfoObject = [

 { key: 'starting_category', label: 'Category' },
{ key: 'starting_collection', label: 'Collection' },
{ key: "manufacturerCode", label: "Manufacturer Code" },
{ key: "starting_description", label: "Quote Description" },
{ key: "metalType", label: "Metal Type" },
{ key: "karat", label: "Karat" },
{ key: "color", label: "Color" },
{ key: "vendor", label: "Vendor" },
{ key: "plating", label: "Plating" },
{ key: "platingCharge", label: "Plating Charge" },
{ key: "length", label: "Length (in)" },
{ key: "width", label: "Width (in)" },
{ key: "height", label: "Height (in)" },
{ key: "weight", label: "Weight (g)" },
{ key: "miscCost", label: "Misc Cost" },
{ key: "laborCost", label: "Labor Cost" },
{ key: "necklace", label: "Necklace True Or False" },
{ key: "necklaceCost", label: "Necklace Cost" },
{key: 'starting_info_id',label: "Starting Info Id"},
// { key: "description", label: "Description" },
// { key: "designId", label: "Design ID" },
{ key: "totalCost", label: "Total Cost" },
{ key: "starting_info_images", label: "Quote Images" },


...stoneHeaders,
{ key: "designId", label: "Design Id" },
]
const headersExport = {
  designs: [
    { key: "id", label: "ID (Design)" },
    { key: "d_description", label: "Design Description" },
    { key: "link", label: "Link" },
    // { key: "collection", label: "Collection" },
    // { key: "category", label: "Category" },
    { key: "d_images", label: "Design Images" },
    { key: "status", label: "Status" },
    { key: "name", label: "Name" },

    ...startingInfoObject
   ],
   samples:[
    {key:'sample_id',label:'ID (Sample)'},
    { key: 'name', label: 'Sku' },
    { key: 'styleNumber', label: 'Style Number' },
    { key: 'cad', label: 'CAD Files' },
    { key: 'salesWeight', label: 'Sales Weight' },
    { key: 'selling_pair', label: 'Selling Pair' },
    { key: 'back_type', label: 'Back Type' },
    { key: 'custom_back_type', label: 'Custom Back Type' },
    { key: 'back_type_quantity', label: 'Back Type Quantity' },
    { key: 'sample_status', label: 'Sample Status' },
    { key: 'notes', label: 'Notes' },
    { key: 'created_at', label: 'Created At' },
    { key: 'updated_at', label: 'Updated At' },
    
    ...startingInfoObject
   ]
}
export const exportToCSV = (products,type) => {
    const dataToExport = products.map((product) => {
       switch(type){
        case 'samples': 
        return flattenSampleOnly(product);
        break;
        case 'designs':
          return flattenDesignOnly(product);
          break;
      }
    });
   const headers = headersExport[type];
  
    // const rows = products.map((product, index) => {
    //   const stone = product.stones?.[0];
    //   const stoneDesc = stone ? 
    //     `CZ/${stone.size.replace('mm', '')} * ${stone.quantity} PC` : '';
  
    //   const remarkParts = [
    //     `Thickness: ${product.metalProperties?.thickness || '0.96'}mm`,
    //     `Tube length: ${product.tubeLength || '7.85'}mm`,
    //     `Disc thickness: ${product.discThickness || '0.6'}mm`,
    //     `Disc diameter: ${product.discDiameter || '3.1'}mm`
    //   ];
  
    //   return [
    //     index + 1,
    //     product.itemNumber,
    //     product.itemCode,
    //     '',  // PHOTO placeholder
    //     stoneDesc,
    //     product.metalProperties?.karatType?.replace('k', ''),
    //     product.metalProperties?.color || 'YG',
    //     remarkParts.join('\n'),
    //     product.quantity,
    //     product.unit || 'PCS',
    //     product.totalWeight.toFixed(2),
    //     product.goldWeight.toFixed(2),
    //     product.goldAmount.toFixed(2),
    //     product.laborCost.toFixed(2),
    //     (product.stones?.[0]?.cost || 0).toFixed(2),
    //     product.unitPrice.toFixed(2),
    //     product.rhodiumCharge.toFixed(2),
    //     product.remarks
    //   ].map(value => 
    //     typeof value === 'string' && value.includes(',') ? 
    //       `"${value}"` : 
    //       value
    //   ).join(',');
    // });
    exportToCSVFile(headers, dataToExport, 'exported_designs.csv');
  
    // const csv = [headers.join(','), ...rows].join('\n');
    // const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    // const url = URL.createObjectURL(blob);
    // const link = document.createElement('a');
    
    // link.setAttribute('href', url);
    // link.setAttribute('download', `jewelry_export_${new Date().toISOString().slice(0,10)}.csv`);
    // document.body.appendChild(link);
    // link.click();
    // document.body.removeChild(link);
    // URL.revokeObjectURL(url);
  };
  function flattenDesignOnly(design,dropdown) {
    return {
      id: design.id ?? "",
      d_description: design.description ?? "",
      link: design.link ?? "",
      collection: dropdown.collection.find(c => c.id === design.collection)?.name ?? "",
      category: dropdown.category.find(c => c.id === design.category)?.name ?? "",
      d_images: design.images?.join(" | ") ?? "",
      status: design.status ?? "",
      name: design.name ?? "",
      
      // STARTING INFO
      manufacturerCode: design.startingInfo?.manufacturerCode || "",
      images: design.startingInfo?.images?.join(" | ") ?? "",
      s_description: design.startingInfo?.description ?? "",
      metalType: design.startingInfo?.metalType ?? "",
      karat: design.startingInfo?.karat ?? "",
      color: design.startingInfo?.color ?? "",
      weight: design.startingInfo?.weight ?? 0,
      height: design.startingInfo?.height ?? 0,
      length: design.startingInfo?.length ?? 0,
      width: design.startingInfo?.width ?? 0,
      
      // â MAP ID TO NAME FOR PLATING AND VENDOR
      plating: dropdown.plating.find(p => p.id === design.startingInfo?.plating)?.name ?? "",
      platingCharge: design.startingInfo?.platingCharge ?? 0,
      necklase: design.startingInfo?.necklase ?? false,
      necklaseCost: design.startingInfo?.necklaseCost ?? 0,
      stones: design.startingInfo?.stones ?? [],
      
      // â MAP ID TO NAME FOR VENDOR
      vendor: dropdown.vendors.find(v => v.id === design.startingInfo?.vendor)?.name ?? "",
      
      status: design.startingInfo?.status ?? "Working_on_it:yellow",
      
      
      ...design.stones?.reduce((acc, stone, i) => {
        if (i >= 10) return acc; // limit to 10 stones
        acc[`stone${i + 1}_id`] = stone.id ?? "";
        acc[`stone${i + 1}_type`] = stone.type ?? "";
        acc[`stone${i + 1}_customType`] = stone.customType ?? "";
        acc[`stone${i + 1}_color`] = stone.color ?? "";
        acc[`stone${i + 1}_shape`] = stone.shape ?? "";
        acc[`stone${i + 1}_size`] = stone.size ?? "";
        acc[`stone${i + 1}_quantity`] = stone.quantity ?? 0;
        acc[`stone${i + 1}_cost`] = stone.cost ?? 0;
        acc[`stone${i + 1}_notes`] = stone.notes ?? "";
        return acc;
      }, {}),

      // designId: design.id

    };
  }
  function flattenSampleOnly(sample,dropdown) {
    console.log(sample)
    const {images,starting_info_images,cad,sample_collection,sample_category,vendor,plating,starting_info_id,...rest} = sample
    return {
      starting_info_images:images.join(' | ') ?? [] ,
      cad: cad.join(' | ') ?? [],
      starting_info_id:starting_info_id,
      collection:dropdown.collection.find(c => c.id === sample_collection)?.name ?? "",
      category:dropdown.category.find(c => c.id === sample_category)?.name ?? "",
      vendor:dropdown.vendors.find(v => v.id === vendor)?.name ?? "",
      plating:dropdown.plating.find(p => p.id === plating)?.name ?? "",

      ...rest
      
    };
  }
  function exportToCSVFile(headers, data, filename = "export.csv") {
    console.log(data, "data to export in exportToCSVFile");
    const csvRows = [];
  
    // Create header row
    const headerRow = headers.map((h) => `"${h.label}"`).join(",");
    csvRows.push(headerRow);
  
    // Create data rows
    for (const row of data) {
      const values = headers.map((h) => {
        const val = row[h.key] ?? "";
        return val;
      });
      csvRows.push(values.join(","));
    }
    console.log(csvRows, "csvRows");  
    // Create Blob and trigger download
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
  
    link.href = url;
    link.setAttribute("download", filename);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
  function getExcelColumnName(index) {
    let name = "";
    while (index >= 0) {
      name = String.fromCharCode((index % 26) + 65) + name;
      index = Math.floor(index / 26) - 1;
    }
    return name;
  }
  
  
  
  import ExcelJS from 'exceljs';

  export async function exportData(data, dropdown, type) {
    const formatted = data.map((item) => {
      const { stones, ...rest } = item;
      // Resolve FK ids to names for Category/Collection on export
      if (rest && dropdown) {
        const _resolveFk = (id, list) => { if (id == null || !Array.isArray(list)) return id; const found = list.find(x => x && (x.id === id || x.id === Number(id) || x.value === id || x.value === Number(id))); return found?.name ?? found?.label ?? id; };
        rest.starting_category = _resolveFk(rest.starting_category, dropdown.category);
        rest.starting_collection = _resolveFk(rest.starting_collection, dropdown.collection);
      }
  
      if (!stones || stones.length === 0) return { ...rest };
  
      const stoneData = stones.reduce((acc, stone, index) => {
        acc[`stone${index + 1}_id`] = stone.id ?? "";
        acc[`stone${index + 1}_type`] = stone.type ?? "";
        acc[`stone${index + 1}_customType`] = stone.customType ?? "";
        acc[`stone${index + 1}_color`] = stone.color ?? "";
        acc[`stone${index + 1}_shape`] = stone.shape ?? "";
        acc[`stone${index + 1}_size`] = stone.size ?? "";
        acc[`stone${index + 1}_quantity`] = stone.quantity ?? 0;
        acc[`stone${index + 1}_cost`] = stone.cost ?? 0;
        acc[`stone${index + 1}_notes`] = stone.notes ?? "";
        return acc;
      }, {});
  
      return { ...rest, ...stoneData };
    });
  
    const flattenedData = formatted.map((product) => {
      switch (type) {
        case 'samples':
          return flattenSampleOnly(product,dropdown);
        case 'designs':
          return flattenDesignOnly(product,dropdown);
      }
    });
  
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Export");
  
    const headers = headersExport[type];
    const headerRow = headers.map((h) => h.label);
    sheet.addRow(headerRow);
  
    // Write data rows
    for (const row of flattenedData) {
      const rowValues = headers.map((h) => row[h.key] ?? "");
      sheet.addRow(rowValues);
    }
  
    // Auto column widths
    sheet.columns = headers.map((h) => ({
      width: Math.max(10, h.label.length),
    }));
  
    // ð¯ Add dropdowns to all rows in specific columns
    const dropdownFields = [
      { field: "plating", values: dropdown.plating },
      { field: "vendor", values: dropdown.vendors },
      { field: "collection", values: dropdown.collection },
      { field: "category", values: dropdown.category },
      { field: "back_type", values: dropdown.backType },
      { field: `stone1_color`, values: dropdown.color },
      { field: `stone2_color`, values: dropdown.color },
      { field: `stone3_color`, values: dropdown.color },
      { field: `stone4_color`, values: dropdown.color },
      { field: `stone5_color`, values: dropdown.color },
      { field: `stone6_color`, values: dropdown.color },
      { field: `stone7_color`, values: dropdown.color },
      { field: `stone8_color`, values: dropdown.color },
      { field: `stone9_color`, values: dropdown.color },
      { field: `stone10_color`,values: dropdown.color },
      
      { field: "stone1_type", values: dropdown.type },
      { field: "stone2_type", values: dropdown.type },
      { field: "stone3_type", values: dropdown.type },
      { field: "stone4_type", values: dropdown.type },
      { field: "stone5_type", values: dropdown.type },
      { field: "stone6_type", values: dropdown.type },
      { field: "stone7_type", values: dropdown.type },
      { field: "stone8_type", values: dropdown.type },
      { field: "stone9_type", values: dropdown.type },
      { field: "stone10_type", values: dropdown.type },
    ];
  
    for (const { field, values } of dropdownFields) {
      const headerIndex = headers.findIndex((h) => h.key === field);
      if(headerIndex===-1) continue
      
      const columnLetter = getExcelColumnName(headerIndex) 
      for (let rowNum = 2; rowNum <= flattenedData.length + 1; rowNum++) {
        sheet.getCell(`${columnLetter}${rowNum}`).dataValidation = {
          type: "list",
          allowBlank: true,
          formulae: [`"${values.map(v => v.name).join(',')}"`],
        };
      }
    }
  
    // Export file
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${type}_export_${Date.now()}.xlsx`;
    a.click();
  }
  
// export function exportData(data,dropdown, type) {
//   console.log(data,dropdown)
//   const formatted = data.map((item) => {
//     const { stones,...rest } = item;

//     if (!stones || stones.length === 0) {
//       return {...rest}; // Skip items with no stones
//     }

//     // Flatten stones with index
//     const stoneData = stones.reduce((acc, stone, index) => {
//       acc[`stone${index + 1}_id`] = stone.id ?? "";
//       acc[`stone${index + 1}_type`] = stone.type ?? "";
//       acc[`stone${index + 1}_customType`] = stone.customType ?? "";
//       acc[`stone${index + 1}_color`] = stone.color ?? "";
//       acc[`stone${index + 1}_shape`] = stone.shape ?? "";
//       acc[`stone${index + 1}_size`] = stone.size ?? "";
//       acc[`stone${index + 1}_quantity`] = stone.quantity ?? 0;
//       acc[`stone${index + 1}_cost`] = stone.cost ?? 0;
//       acc[`stone${index + 1}_notes`] = stone.notes ?? "";
//       return acc;
//     }, {});

//     return {
//       ...rest, // Include other fields from the item
//       ...stoneData, // Merge flattened stones into the item
//     };
//   })
//   console.log(formatted, "formatted")
//   const flattenedData = formatted.map((product) => {
//        switch(type){
//         case 'samples': 
//         return product
//         break;
//         case 'designs':
//           return flattenDesignOnly(product);
//           break;
        
//       }
//     });
//     const headersToExport = headersExport[type].map((header) => header.label); // Array, not .join(",")
//     const makingSheet = [headersToExport]; // This is your sheet as an array of arrays
//     // Step 2: Add data rows
//     for (let row of flattenedData) {
//       const makingRow = headersExport[type].map((header) => row[header.key] ?? "");
//       makingSheet.push(makingRow);
//     }
    
//     // Step 3: Convert to worksheet
//     const ws = XLSX.utils.aoa_to_sheet(makingSheet);
//     ws['!cols'] = headersToExport[type].map(header => ({
//       wch: Math.max(10, header.label.length)
//     }));
//     addDropdowns(ws,headersExport[type],dropdown.plating,"plating")
//     addDropdowns(ws,headersExport[type],dropdown.vendors,"vendor")
//     addDropdowns(ws,headersExport[type],dropdown.collection,"collection")
//     addDropdowns(ws,headersExport[type],dropdown.category,"category")
//     // Step 4: Build workbook and trigger download
//     const wb = XLSX.utils.book_new();
//     XLSX.utils.book_append_sheet(wb, ws, "Export");
    
//     const arrayBuffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
//     const blob = new Blob([arrayBuffer], {
//       type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
//     });
//     const url = URL.createObjectURL(blob);
//     const a = document.createElement("a");
//   a.href = url;
//   a.download = `${type}_export_${Date.now()}.xlsx`;
//   a.click();
// }


// function addDropdowns(ws, headers, dropdownOptions, headerKeys) {
//   const dataValidationRules = headers.map((key) => {
//     const column = getColumnIndex(headers, headerKeys); // Find column based on key
//     if (!column) return null;

//     return {
//       type: "list",
//       allowBlank: true,
//       formula1: `"${dropdownOptions.join(",")}"`, // Dropdown options
//       sqref: `${column}2:${column}100`, // Apply dropdown to rows 2-100 in the column
//     };
//   });

//   ws["!dataValidation"] = dataValidationRules.filter((rule) => rule !== null);
// }

// function getColumnIndex(headers, headerKey) {
//   // Find the index of the header based on its key
//   const index = headers.findIndex((header) => header.key === headerKey);

//   if (index === -1) {
//     console.error(`Header key "${headerKey}" not found.`);
//     return null;
//   }

//   // Convert index to Excel column (e.g., 0 â A, 1 â B, etc.)
//   const column = String.fromCharCode(65 + index); // ASCII code for 'A' is 65
//   return column;
// }