import { addGuestAction } from "@/app/actions";
import { btn, Card, ErrorBanner, Field, input, PageHeader } from "@/app/ui";
import { getDb } from "@/server/db/client";
import { getCtx } from "@/server/session";
import { searchGuests } from "@/server/services/guests";

export default async function Guests({ searchParams }: PageProps<"/app/guests">) {
  const { error, q } = await searchParams;
  const guests = await searchGuests(getDb(), await getCtx(), typeof q === "string" ? q : "");
  return (
    <>
      <PageHeader title="Guests" />
      <ErrorBanner message={typeof error === "string" ? error : undefined} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Add guest">
          <form action={addGuestAction} className="space-y-3">
            <Field label="Name"><input name="name" required className={input} /></Field>
            <Field label="Phone"><input name="phone" className={input} /></Field>
            <Field label="Email"><input name="email" type="email" className={input} /></Field>
            <button className={btn}>Add</button>
          </form>
        </Card>
        <Card title="Search">
          <form className="mb-3 flex gap-2"><input name="q" defaultValue={typeof q === "string" ? q : ""} placeholder="Name or phone" className={input} /><button className={btn}>Go</button></form>
          <ul className="divide-y text-sm">
            {guests.map((g) => (
              <li key={g.id} className="py-2">{g.name} <span className="text-slate-500">{g.phone ?? ""}</span></li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
