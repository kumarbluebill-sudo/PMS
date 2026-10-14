import { Breadcrumbs } from "@/components/Breadcrumbs";
import { Card, PageHeader } from "@/app/ui";
import ImportForm from "./ImportForm";

export default function ImportRooms() {
  return (
    <>
      <Breadcrumbs items={[{ label: "Rooms", href: "/app/rooms" }, { label: "Import" }]} />
      <PageHeader title="Import rooms" subtitle="Upload a CSV or Excel file. Every row is checked first; nothing is saved unless all rows are valid." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Upload">
          <ImportForm />
        </Card>
        <Card title="Format">
          <p className="text-sm text-slate-600">Columns: <code>room_number</code>, <code>category</code>, <code>building</code>, <code>floor</code>. Category, building and floor must already exist (see Room types and Buildings &amp; floors). Building and floor are optional.</p>
          <p className="mt-3 text-sm"><a className="text-indigo-700 underline" href="/app/rooms/import/template">Download CSV template</a></p>
        </Card>
      </div>
    </>
  );
}
