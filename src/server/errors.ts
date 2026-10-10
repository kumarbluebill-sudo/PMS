export class AppError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "CONFLICT" | "VALIDATION" | "UNAUTHENTICATED" | "FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Safe, structured shape for clients. Never includes stack traces or DB details. */
export function toSafeError(e: unknown): { code: string; message: string } {
  if (e instanceof AppError) return { code: e.code, message: e.message };
  if (e instanceof Error && e.name === "ForbiddenError") return { code: "FORBIDDEN", message: e.message };
  if (e instanceof Error && e.name === "InvalidTransitionError") return { code: "CONFLICT", message: e.message };
  if (e instanceof Error && e.name === "ZodError") return { code: "VALIDATION", message: "Some fields are invalid." };
  return { code: "INTERNAL", message: "Something went wrong. Please try again." };
}
