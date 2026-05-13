import { useMetalPriceStore } from "../../store/MetalPrices";
import { purity } from '../../utils/MetalTypeUtil';
import { useEffect, useState, useMemo } from "react";


// export default function CalculatePrice({ 
//     type: originalType, 
//     weight, 
//     karat, 
//     lossPercent, 
//     onCostChange, 
//     cost, 
//     setCost 
// }) {
//     const { prices } = useMetalPriceStore();  // Get prices from the store

//     let type = originalType.toLowerCase();   // Normalize type to lowercase
//     let buyingFee = 1;

//     // Memoize the calculated cost
//     const calculatedCost = useMemo(() => {
//         if (prices[type]?.price && weight && purity[karat] && lossPercent) {
//             return parseFloat(((weight * prices[type].price * purity[karat] * buyingFee) / 31.1035) * lossPercent.toFixed(2));
//         }
//         return "0.00";
//     }, [prices, type, weight, karat, lossPercent]);

//     // Update state and notify parent when calculatedCost changes
//     useEffect(() => {
//         if (cost !== calculatedCost) {
//             setCost((previousCosts)=> previousCosts[previousCosts.find(name => name === "Metal Value:")].value = calculatedCost);

//             if (onCostChange) {
//                 onCostChange(calculatedCost);
//             }
//         }
//     }, [calculatedCost, cost, setCost, onCostChange]); // Prevent unnecessary re-renders

//     return (
//         <div className="flex flex-col bg-gray-100 rounded-md p-2">
//             <span>Calculated Metal Price:</span>
//             <span>$ {cost}</span>
//             <span className="text-sm">Last updated: {prices[type]?.timestamp || "N/A"}</span>
//             <span className="text-sm">Price based on: {prices[type]?.price || "N/A"}</span>
//         </div>
//     );
// }


export default function CalculateMetalCost({ type: originalType, weight, karat, lossPercent, onMetalCostChange }) {
    
    const { prices } = useMetalPriceStore();
    let type = originalType?.toLowerCase() || "";
    let buyingFee = 1;
    const lossPercentFormated =( lossPercent >=1 ? (lossPercent/100):lossPercent)+1

    // Compute metal price dynamically
    const metalCost = useMemo(() => {
        if (prices[type]?.price && weight && purity[karat] && lossPercent) {
            console.log(parseFloat(prices[type].price),weight,purity[karat],lossPercentFormated )
            return parseFloat(((weight * parseFloat(prices[type].price )*purity[karat] * buyingFee) / 31.1035) *lossPercentFormated).toFixed(2);        }
        return 0.00;
    }, [prices, type, weight, karat, lossPercent]);
    // Update PricingContext when metal cost changes
    useEffect(() => {
        if (onMetalCostChange) {
            onMetalCostChange(parseFloat(metalCost)); // Send to parent
        }
    }, [metalCost, onMetalCostChange]);

    return (
        <div className="flex flex-col bg-gray-100 rounded-md p-2">
            <span>Metal Price:</span>
            <span>$ {metalCost}</span>
            <span className="text-sm">Last updated: {prices[type]?.timestamp || "N/A"}</span>
            <span className="text-sm">Price based on: {prices[type]?.price || "N/A"}</span>
        </div>
    );
}
const getMetalCost = (metalPrice, weight, karat, lossPercent) => {
    console.log(metalPrice, weight, purity["925"], lossPercent);

    let buyingFee = 1;
    const lossPercentFormatted = (lossPercent >= 1 ? lossPercent / 100 : lossPercent) + 1;


    if (metalPrice && weight && lossPercentFormatted) {
        console.log('calculated price', Number((((weight * metalPrice * buyingFee) / 31.1035) * lossPercentFormatted).toFixed(2)))
        return Number((((weight * metalPrice *purity[karat] * buyingFee) / 31.1035) * lossPercentFormatted).toFixed(2));
    }
    return 0.00;
};


export {getMetalCost} 
