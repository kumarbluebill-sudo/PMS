"use client";

export default function AppError({ reset }: { error: Error; reset: () => void }) {
  // Never render error.message: it may contain internals. Production builds redact it anyway.
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
      <p>You may not have access to this page, or something went wrong.</p>
      <button onClick={reset} className="mt-2 underline">
        Try again
      </button>
    </div>
  );
}
