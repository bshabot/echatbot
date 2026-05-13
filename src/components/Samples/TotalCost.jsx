import { useState, useEffect } from "react";

export default function TotalCost({ metalCost, miscCost, laborCost, stones, platingCharge, updateTotalCost }) {
  // Calculate stone cost dynamically
  const stoneCost = stones.reduce((sum, stone) =>
    sum + (Number(stone.cost) * Number(stone.quantity) || 0), 0
  );

  // Plating charge: only added when > 0 (per Brian's decision)
  const plating = Number(platingCharge) > 0 ? Number(platingCharge) : 0;

  const totalCost = (
    Number(metalCost || 0) +
    Number(miscCost || 0) +
    Number(laborCost || 0) +
    stoneCost +
    plating
  ).toFixed(2);

  useEffect(() => {
    if (updateTotalCost) {
      updateTotalCost(totalCost);
    }
  }, [totalCost]);

  return (
    <div className="flex flex-col bg-gray-100 rounded-md p-2">
      <span>Metal Value: ${metalCost}</span>
      <span>Misc Charge: ${miscCost || 0}</span>
      <span>Labor Charge: ${laborCost || 0}</span>
      <span>Stone(s) Charge: ${stoneCost}</span>
      {plating > 0 && <span>Plating Charge: ${plating}</span>}
      <hr className="border-t-1 border-gray-400 my-4" />
      <strong>Total: ${totalCost}</strong>
    </div>
  );
}

const getTotalCost = (metalCost = 0, miscCost = 0, laborCost = 0, stones = [], platingCharge = 0) => {
  const stoneCost = stones.reduce((sum, stone) =>
    sum + (Number(stone.cost) * Number(stone.quantity) || 0), 0
  );

  // Plating charge: only added when > 0 (per Brian's decision)
  const plating = Number(platingCharge) > 0 ? Number(platingCharge) : 0;

  const totalCost =
    parseFloat(metalCost) +
    parseFloat(miscCost) +
    parseFloat(laborCost) +
    parseFloat(stoneCost) +
    parseFloat(plating);

  return totalCost;
};

export { getTotalCost };
