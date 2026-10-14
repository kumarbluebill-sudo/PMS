"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-reads the board every few seconds when the property has turned this on in settings. 0 means off. */
export default function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    if (seconds < 15) return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(t);
  }, [seconds, router]);
  return null;
}
