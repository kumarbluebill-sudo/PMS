"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Side panel for the room board. On large screens it sits beside the rooms; on smaller screens it becomes a
 * "Display options" button that opens a slide-over (Escape or the backdrop closes it, focus returns to the button).
 */
export default function BoardPanel({ children, summary, label = "Display options" }: { children: ReactNode; summary: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [desktop, setDesktop] = useState(true);
  const btn = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDesktop(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (open && !desktop) {
      close.current?.focus();
      document.body.style.overflow = "hidden";
      wasOpen.current = true;
      return () => {
        document.body.style.overflow = "";
      };
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      btn.current?.focus();
    }
  }, [open, desktop]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-controls="board-panel"
        onClick={() => setOpen(true)}
        className="mb-3 flex w-full items-center justify-between gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 shadow-sm lg:hidden"
      >
        <span>{label}</span>
        <span className="text-xs font-normal text-slate-600">{summary}</span>
      </button>
      {open && !desktop && <div aria-hidden onClick={() => setOpen(false)} className="fixed inset-0 z-40 bg-slate-950/50 lg:hidden" />}
      <aside
        id="board-panel"
        aria-label={label}
        inert={!desktop && !open}
        onKeyDown={(e) => e.key === "Escape" && open && setOpen(false)}
        className={`fixed inset-y-0 right-0 z-50 w-[22rem] max-w-[92vw] overflow-y-auto bg-white p-4 shadow-xl transition-transform duration-150 lg:static lg:z-auto lg:w-auto lg:max-w-none lg:translate-x-0 lg:overflow-visible lg:bg-transparent lg:p-0 lg:shadow-none ${open ? "translate-x-0" : "translate-x-full max-lg:invisible"}`}
      >
        <button ref={close} type="button" onClick={() => setOpen(false)} className="mb-3 ml-auto block rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 lg:hidden">
          Close
        </button>
        {children}
      </aside>
    </>
  );
}
