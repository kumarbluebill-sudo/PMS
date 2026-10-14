"use client";

import { useEffect } from "react";

/** Remembers the chosen room-board view on this device so the next visit opens in the same view. */
export default function ViewMemory({ view }: { view: "tiles" | "table" | "plan" }) {
  useEffect(() => {
    try {
      document.cookie = `pms_dash_view=${view}; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* cookies unavailable: the view simply is not remembered */
    }
  }, [view]);
  return null;
}
