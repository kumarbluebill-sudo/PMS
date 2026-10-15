"use client";

import { useEffect, useState } from "react";

/**
 * Warns before leaving an edit form with unsaved changes. Put it inside the form: it watches that form's inputs,
 * shows a small "unsaved changes" note, and asks the browser to confirm if the page is closed or left. Submitting the
 * form clears the warning.
 */
export default function UnsavedGuard({ formId }: { formId: string }) {
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const form = document.getElementById(formId);
    if (!form) return;
    const mark = () => setDirty(true);
    const clear = () => setDirty(false);
    form.addEventListener("input", mark);
    form.addEventListener("change", mark);
    form.addEventListener("submit", clear);
    form.addEventListener("reset", clear);
    return () => {
      form.removeEventListener("input", mark);
      form.removeEventListener("change", mark);
      form.removeEventListener("submit", clear);
      form.removeEventListener("reset", clear);
    };
  }, [formId]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  return (
    <p role="status" aria-live="polite" className={dirty ? "text-xs font-medium text-amber-900" : "sr-only"}>
      {dirty ? "You have unsaved changes." : "No unsaved changes."}
    </p>
  );
}
