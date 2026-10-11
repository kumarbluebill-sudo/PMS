const WORDS = ["Poor", "Fair", "Good", "Very good", "Excellent"];

/** 1 to 5 as radio buttons with text labels, so it works without JavaScript and is not colour-dependent. */
export function RatingField({ name, label, required = false }: { name: string; label: string; required?: boolean }) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-sm font-medium text-slate-700">{label}{required ? "" : " (optional)"}</legend>
      <div className="flex flex-wrap gap-2">
        {WORDS.map((w, i) => (
          <label key={w} className="flex cursor-pointer items-center gap-1 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm has-[:checked]:border-slate-900 has-[:checked]:bg-slate-900 has-[:checked]:text-white has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2">
            <input type="radio" name={name} value={i + 1} required={required && i === 0} className="sr-only" />
            <span aria-hidden="true">{i + 1}</span>
            <span className="text-xs">{w}</span>
            <span className="sr-only">{` (${i + 1} out of 5)`}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
