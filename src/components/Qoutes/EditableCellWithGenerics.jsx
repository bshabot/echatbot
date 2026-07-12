import { useEffect,useState} from "react";

export default function EditableCellWithGeneric({ 
    handleChange, 
    setEditingCell, 
    editingCell, 
    cellType, 
    inputType = 'text',
    id, 
    data
}) {
    // console.log(data,'in editable cell','cell type',cellType)

    const [customValue, setCustomValue] = useState(data);
    useEffect(() => {
        console.log('data changed',data);
        setCustomValue(data);
    }, [data]);
    useEffect(() => {
        // console.log('cell type',cellType,editingCell)
    }, [editingCell]);
    return (
        <td
            className=" border border-gray-300 p-2 text-center cursor-pointer"
            onClick={() => setEditingCell({ id, field: cellType })}
        >
            {editingCell?.field === cellType && editingCell?.id === id ? (
                    
                    <input
                        type={inputType}
                        enterKeyHint="done"
                        value={customValue}
                        onChange={(e) => setCustomValue(e.target.value)}
                        onBlur={() => {
                            console.log("Saving data:", customValue); // Log the value before sending it back
                            handleChange(id, cellType, customValue);
                            setEditingCell(null);
                          }}
                        onKeyDown={(e) => { if(e.key === "Enter"){
                            console.log("Saving data:", customValue); // Log the value before sending it back
                            handleChange(id, cellType, customValue)
                                setEditingCell(null)}}

                        }
                        className="border border-gray-300 p-1 w-full text-center"
                        autoFocus
                    />
                
            ) : (
                !customValue || customValue === '' ?  "Click to edit": cellType.toLowerCase().includes('price') ? `$${customValue}` : customValue
            )}
        </td>
    );
}
