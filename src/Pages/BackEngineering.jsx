// DEPRECATED 2026-05-19 — back-engineering merged into /purchase-orders.
// This file is kept only so old bookmarks don't break. Remove after a sprint
// or two if no one hits it.
import React from "react";
import { Navigate } from "react-router-dom";

export default function BackEngineering() {
  return <Navigate to="/purchase-orders" replace />;
}
