import Link from "next/link";

export type Crumb = { label: string; href?: string };

/** Trail shown above a page title. The last item is the current page. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (items.length === 0) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-1 text-xs text-slate-500">
      <ol className="flex flex-wrap items-center gap-1">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={`${c.label}-${i}`} className="flex items-center gap-1">
              {c.href && !last ? <Link href={c.href} className="underline">{c.label}</Link> : <span aria-current={last ? "page" : undefined}>{c.label}</span>}
              {!last && <span aria-hidden>/</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
