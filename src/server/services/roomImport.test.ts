import { describe, expect, it } from "vitest";
import { gridToRows, parseCsv } from "./roomImport";

describe("parseCsv", () => {
  it("handles quotes, escaped quotes, CRLF, BOM and blank lines", () => {
    const g = parseCsv('\uFEFFa,b\r\n"x, y","say ""hi"""\r\n\r\n3,4');
    expect(g).toEqual([["a", "b"], ["x, y", 'say "hi"'], ["3", "4"]]);
  });
});

describe("gridToRows", () => {
  const head = ["room_number", "category", "building", "floor"];
  it("accepts valid rows", () => {
    const r = gridToRows([head, ["101", "Deluxe", "Main", "F1"], ["102", "Deluxe", "", ""]]);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(2);
  });
  it("reports row-level errors with line numbers", () => {
    const r = gridToRows([head, ["", "Deluxe", "", ""], ["101", "", "", ""], ["101", "Deluxe", "", ""], ["103", "Deluxe", "", "F1"]]);
    expect(r.errors.map((e) => [e.line, e.message.split(" ")[0]])).toEqual([[2, "Room"], [3, "Category"], [4, "Room"], [5, "A"]]);
  });
  it("rejects a missing required column", () => {
    expect(() => gridToRows([["room_number"], ["1"]])).toThrow(/Missing column/);
  });
});
