import React, { useEffect } from "react";
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";
import Sidebar from "./components/SideBar";
import Header from "./components/Header";
import { useMetalPriceStore } from "./store/MetalPrices";
import Ideas from "./Pages/Ideas";
import Vendors from "./Pages/Vendor";
import Products from "./Pages/Products";
import Designs from "./Pages/Designs";
import Samples from "./Pages/Samples";
import Quote from "./Pages/Quote";
import NewQuote from "./Pages/NewQuote";
import ViewQuote from "./Pages/ViewQuote";
import MetalPrices from "./Pages/MetalPrices";
import DesignQuote from "./Pages/DesignQuotes";
import Settings from "./Pages/Settings";
import Login from "./Pages/Login";
import VendorPreloader from "./components/VendorPreloader";
import "./App.css";
import SupaBaseProvider, { useSupabase } from "./components/SupaBaseProvider";
import { MessageProvider } from "./components/Messages/MessageContext";
import MessageBox from "./components/Messages/MessageBox";
import { AlertProvider } from "./components/Alerts/AlertContext";
import { Navigate } from "react-router-dom";
import ImageManager from "./components/ImageManager";
import RunningLines from "./Pages/RunningLines";
import ImportHistory from "./Pages/ImportHistory";
import PurchaseOrders from "./Pages/PurchaseOrders";
import MetalLocks from "./Pages/MetalLocks";
import Shipments from "./Pages/Shipments";
import { useGenericStore } from "./store/VendorStore";
function AppContent() {
  useEffect(() => {
    const handleStorageChange = (event) => {
      if (event.key === "vendors") {
        // Sync the store with the updated localStorage data
        useGenericStore.getState().syncEntityFromLocalStorage("vendors");
      }
    };

    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);
  const { session, supabase } = useSupabase(); // Get the current session from Supabase
  // Keep metal prices in sync across users.
  // On mount + focus: pull latest from metal_lock_history (canonical Signet
  // London-fix lock) → also updates the shared metal_prices table. Then refresh
  // local store from metal_prices in case other clients have changed it manually.
  useEffect(() => {
    if (!supabase) return;
    const sync = async () => {
      await useMetalPriceStore.getState().syncFromLatestLock(supabase);
      await useMetalPriceStore.getState().syncFromDb(supabase);
    };
    sync();
    const onVis = () => { if (document.visibilityState === "visible") sync(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", sync);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", sync);
    };
  }, [supabase]);

  // If no session exists, show the login screen
  if (!session) {
    return (
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/viewQuote" element={<ViewQuote />} />
        <Route path="/" element={<Navigate to="/login" />} />
      </Routes>
    );
  }

  // Extract the user's role from session metadata
  const userRole = session || "buyer"; // Default to 'buyer' if no role is set

  return (
    <div className="flex min-h-screen bg-gray-100">
      {/* Conditionally render Sidebar and Header for agents */}
      {session && <Sidebar />}
      {/* max-md:min-w-0 — flex items default to min-width:auto, so one wide
          table row propagates its min-content width up and blows the whole
          page out past the viewport (Shipments tabs were unreachable).
          min-width:0 lets pages shrink to the phone; tables scroll inside. */}
      <div className={session ? "flex-1 ml-64 max-md:ml-14 max-md:min-w-0" : "flex-1 max-md:min-w-0"}>
        <div className="flex flex-col min-h-screen">
          {/* {session && <Header />} */}
          <main className={session ? "flex-1 p-6 pt-2 max-md:p-3 max-md:pt-2" : "flex-1 p-6 max-md:p-3"}>
            <Routes>
              {/* Route accessible to both buyers and agents */}
              <Route path="/viewQuote" element={<ViewQuote />} />
              {/* Protected Routes for agents */}
              {session && (
                <>
                  <Route path="/ideas" element={<Ideas />} />
                  <Route path="/products" element={<Products />} />
                  <Route path="/designs" element={<Designs />} />
                  <Route path="/samples" element={<Samples />} />
                  <Route path="/quotes" element={<Quote />} />
                  <Route path="/newQuote" element={<NewQuote />} />
                  <Route path="/prices" element={<MetalPrices />} />
                  <Route path="/vendors" element={<Vendors />} />
                  <Route path="/designQuote" element={<DesignQuote />} />
                  <Route path="/images" element={<ImageManager />} />
                  <Route path="/running-lines" element={<RunningLines />} />
                  <Route path="/import-history" element={<ImportHistory />} />
                  <Route path="/purchase-orders" element={<PurchaseOrders />} />
                  <Route path="/shipments" element={<Shipments />} />
                  <Route path="/metal-locks" element={<MetalLocks />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="*" element={<Navigate to="/Ideas" />} />
                </>
              )}
              {/* <Route path="/" element={<Navigate to="/login" />} /> */}
            </Routes>
          </main>
        </div>
      </div>
    </div>
  );
}

function App() {
  return (
    <SupaBaseProvider>
      <VendorPreloader />
      <MessageProvider>
        <MessageBox />
        <AlertProvider>
          <Router>
            <AppContent />
          </Router>
        </AlertProvider>
      </MessageProvider>
    </SupaBaseProvider>
  );
}

export default App;
