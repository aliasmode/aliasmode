import { expect, test } from "bun:test";
import { isSafeProfileId, MAX_PROFILE_ID_LENGTH } from "./profile-id.ts";

test("profile ids accept AdsPower/UUID forms (incl. mixed case) and reject filesystem aliases", () => {
  expect(isSafeProfileId("k1d0cd11")).toBe(true);
  expect(isSafeProfileId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  expect(isSafeProfileId(`a${"_".repeat(MAX_PROFILE_ID_LENGTH - 1)}`)).toBe(true);
  // Mixed-case ids the pre-hardening release persisted verbatim must stay
  // operable — they are path-safe and only need distinct directory names.
  expect(isSafeProfileId("CaseID")).toBe(true);
  expect(isSafeProfileId("K1D0CD11")).toBe(true);

  for (const unsafe of [
    "../shared",
    "safe/shared",
    "safe\\shared",
    "safe%2Fshared",
    "safe%5Cshared",
    ".",
    "..",
    "./shared",
    "C:\\shared",
    "C:/shared",
    // Windows device names are rejected case-insensitively.
    "CON",
    "con",
    "nul",
    "com1",
    "lpt9",
    "-leading",
    "_leading",
    `a${"x".repeat(MAX_PROFILE_ID_LENGTH)}`,
  ]) {
    expect(isSafeProfileId(unsafe)).toBe(false);
  }
});
