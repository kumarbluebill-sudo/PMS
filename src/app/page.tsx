import Link from "next/link";
import { btn } from "@/app/ui";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4">
      <h1 className="text-3xl font-semibold">MK Solutions Hotel PMS</h1>
      <p className="text-slate-600">
        Cloud property management for hotels and resorts: rooms, reservations, front desk and housekeeping.
      </p>
      <div className="flex gap-3">
        <Link href="/register" className={btn}>
          Get started
        </Link>
        <Link href="/login" className="rounded-md border border-slate-300 px-3 py-2 text-sm">
          Sign in
        </Link>
      </div>
    </main>
  );
}
