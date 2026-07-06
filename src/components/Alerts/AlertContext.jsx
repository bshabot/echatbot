import React, { Fragment, createContext, useCallback, useContext, useState } from "react";
import { Dialog, Transition } from "@headlessui/react";
import { X, CheckCircle2, AlertTriangle, XCircle, Info } from "lucide-react";

// ---------------------------------------------------------------------------
// App-wide alert / confirm popups, styled like the quote "Add Items" select
// (CustomSelectWithSelections). Replaces window.alert / window.confirm.
//
// Usage:
//   const { showAlert, showConfirm, showPrompt } = useAlert();
//   await showAlert("Export failed: " + e.message, { variant: "error" });
//   const ok = await showConfirm("Delete 3 POs?", { confirmText: "Delete", variant: "error" });
//   const name = await showPrompt("New style number:", { title: "Duplicate" }); // null = cancelled
//
// Z-LAYER SCALE (keep every overlay on this scale — see index.css):
//   z-10  in-page (sticky table headers, card badges)
//   z-30  app chrome (sidebar, header)
//   z-40  popovers / dropdowns / tooltips
//   z-50  modals
//   z-[60] modals stacked on modals (confirm, image peek)
//   z-[70] alerts (this file) — always on top
// ---------------------------------------------------------------------------

const AlertContext = createContext(null);

export function useAlert() {
  const ctx = useContext(AlertContext);
  if (!ctx) throw new Error("useAlert must be used inside <AlertProvider>");
  return ctx;
}

const VARIANTS = {
  info:    { Icon: Info,         icon: "text-blue-500",  ring: "bg-blue-50" },
  success: { Icon: CheckCircle2, icon: "text-green-500", ring: "bg-green-50" },
  warning: { Icon: AlertTriangle,icon: "text-amber-500", ring: "bg-amber-50" },
  error:   { Icon: XCircle,      icon: "text-red-500",   ring: "bg-red-50" },
};

export function AlertProvider({ children }) {
  const [dialog, setDialog] = useState(null);
  const [inputVal, setInputVal] = useState("");

  const showAlert = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setDialog({
        kind: "alert",
        message,
        title: opts.title || "Notice",
        variant: opts.variant || "info",
        okText: opts.okText || "OK",
        resolve,
      });
    });
  }, []);

  const showConfirm = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setDialog({
        kind: "confirm",
        message,
        title: opts.title || "Are you sure?",
        variant: opts.variant || "warning",
        confirmText: opts.confirmText || "Confirm",
        cancelText: opts.cancelText || "Cancel",
        resolve,
      });
    });
  }, []);

  // Prompt popup (replaces window.prompt). Resolves the entered string, or
  // null when cancelled.
  const showPrompt = useCallback((message, opts = {}) => {
    return new Promise((resolve) => {
      setInputVal(opts.defaultValue || "");
      setDialog({
        kind: "prompt",
        message,
        title: opts.title || "Enter a value",
        variant: opts.variant || "info",
        placeholder: opts.placeholder || "",
        confirmText: opts.confirmText || "OK",
        cancelText: opts.cancelText || "Cancel",
        resolve,
      });
    });
  }, []);

  const dismissValue = (d) => (d?.kind === "confirm" ? false : d?.kind === "prompt" ? null : undefined);

  const close = (result) => {
    if (dialog) dialog.resolve(result);
    setDialog(null);
  };

  const v = VARIANTS[dialog?.variant] || VARIANTS.info;
  const { Icon } = v;

  return (
    <AlertContext.Provider value={{ showAlert, showConfirm, showPrompt }}>
      {children}
      <Transition appear show={!!dialog} as={Fragment}>
        <Dialog as="div" className="relative z-[70]" onClose={() => close(dismissValue(dialog))}>
          <Transition.Child
            as={Fragment}
            enter="ease-out duration-300" enterFrom="opacity-0" enterTo="opacity-100"
            leave="ease-in duration-200" leaveFrom="opacity-100" leaveTo="opacity-0"
          >
            <div className="fixed inset-0 bg-black bg-opacity-25" />
          </Transition.Child>

          <div className="fixed inset-0 overflow-y-auto">
            <div className="flex min-h-full items-center justify-center p-4 text-center">
              <Transition.Child
                as={Fragment}
                enter="ease-out duration-300" enterFrom="opacity-0 scale-95" enterTo="opacity-100 scale-100"
                leave="ease-in duration-200" leaveFrom="opacity-100 scale-100" leaveTo="opacity-0 scale-95"
              >
                <Dialog.Panel className="w-full max-w-md transform overflow-hidden rounded-2xl bg-white p-6 text-left align-middle shadow-xl transition-all">
                  <div className="flex justify-between items-center">
                    <Dialog.Title as="h3" className="text-lg font-medium leading-6 text-gray-900 flex items-center gap-2">
                      <span className={`p-1.5 rounded-full ${v.ring}`}>
                        <Icon className={`w-5 h-5 ${v.icon}`} />
                      </span>
                      {dialog?.title}
                    </Dialog.Title>
                    <button
                      onClick={() => close(dismissValue(dialog))}
                      className="text-gray-500 hover:text-gray-700"
                    >
                      <X className="w-5 h-5" />
                    </button>
                  </div>

                  <p className="mt-3 text-sm text-gray-700 whitespace-pre-wrap break-words">
                    {dialog?.message}
                  </p>

                  {dialog?.kind === "prompt" && (
                    <input
                      type="text"
                      autoFocus
                      value={inputVal}
                      placeholder={dialog?.placeholder}
                      onChange={(e) => setInputVal(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") close(inputVal); }}
                      className="mt-3 w-full border border-gray-300 rounded-lg p-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  )}

                  <div className="mt-5 flex gap-3">
                    {(dialog?.kind === "confirm" || dialog?.kind === "prompt") && (
                      <button
                        type="button"
                        className="inline-flex justify-center flex-1 rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                        onClick={() => close(dismissValue(dialog))}
                      >
                        {dialog?.cancelText}
                      </button>
                    )}
                    <button
                      type="button"
                      className={`inline-flex justify-center flex-1 rounded-md border border-transparent px-4 py-2 text-sm font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${
                        dialog?.kind === "confirm" && dialog?.variant === "error"
                          ? "bg-red-600 hover:bg-red-700 focus-visible:ring-red-500"
                          : "bg-blue-500 hover:bg-blue-600 focus-visible:ring-blue-500"
                      }`}
                      onClick={() => close(dialog?.kind === "confirm" ? true : dialog?.kind === "prompt" ? inputVal : undefined)}
                    >
                      {dialog?.kind === "alert" ? dialog?.okText : dialog?.confirmText}
                    </button>
                  </div>
                </Dialog.Panel>
              </Transition.Child>
            </div>
          </div>
        </Dialog>
      </Transition>
    </AlertContext.Provider>
  );
}

export default AlertProvider;
