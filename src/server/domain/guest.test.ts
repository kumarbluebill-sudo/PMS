import { describe, expect, it } from "vitest";
import { maskEmail, maskPhone, phoneKey, phoneQuery } from "./guest";

describe("guest phone matching", () => {
  it("gives the same key for every common way of writing a number", () => {
    const keys = ["9876543210", "+91 98765 43210", "098765-43210", "(+91) 98765 43210", "0091 9876543210"].map(phoneKey);
    expect(new Set(keys)).toEqual(new Set(["9876543210"]));
  });
  it("has no key for numbers too short to identify anyone", () => {
    expect(phoneKey("123")).toBeNull();
    expect(phoneKey("")).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey("12 34")).toBe("1234");
  });
  it("treats long numbers as exact and short ones as fragments, and ignores words", () => {
    expect(phoneQuery("+91 98765 43210")).toEqual({ kind: "exact", key: "9876543210" });
    expect(phoneQuery("98765")).toEqual({ kind: "fragment", digits: "98765" });
    expect(phoneQuery("987")).toBeNull();
    expect(phoneQuery("Asha Verma")).toBeNull();
    expect(phoneQuery("asha 98765")).toBeNull();
  });
  it("masks phones and emails for logs", () => {
    expect(maskPhone("+91 98765 43210")).toBe("…3210");
    expect(maskPhone("")).toBeNull();
    expect(maskEmail("asha@example.com")).toBe("a…@example.com");
    expect(maskEmail("nope")).toBeNull();
  });
});
