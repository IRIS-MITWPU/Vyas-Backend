import { z } from "zod";
import { invalid } from "./errors.js";
import { INT4_MAX } from "./domain/limits.js";

/**
 * Parses `data` with a zod schema. On failure throws a 400 VALIDATION_ERROR whose
 * details.fieldErrors maps a dotted field path ("faculty.0.faculty_id") to messages;
 * issues without a path are collected under "_".
 */
export function parse(schema, data) {
  const result = schema.safeParse(data === undefined ? {} : data);
  if (result.success) return result.data;
  const fieldErrors = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_";
    (fieldErrors[key] ||= []).push(issue.message);
  }
  throw invalid("Some fields are invalid", fieldErrors);
}

/** Throws a 400 VALIDATION_ERROR for one field. */
export function failField(field, message) {
  throw invalid(message, { [field]: [message] });
}

// ---- shared field schemas ----
export const uuid = z.string().uuid("must be a valid id");
export const text = (max = 200) => z.string().trim().min(1, "is required").max(max, `must be at most ${max} characters`);
export const optText = (max = 200) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? null : v), z.string().trim().max(max).nullable().optional());
export const int = (min, max) => z.number({ error: "must be a whole number" }).int("must be a whole number").min(min, `must be ${min} or more`).max(max ?? INT4_MAX, `must be ${max ?? INT4_MAX} or less`);
export const optInt = (min, max) => int(min, max).nullable().optional();
/** Same as int / optInt but takes a { min, max } range from domain/limits.js. */
export const intIn = (r) => int(r.min, r.max);
export const optIntIn = (r) => optInt(r.min, r.max);
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
export const dateStr = z
  .string()
  .regex(dateRe, "must be a date like 2026-07-27")
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s), "must be a real date");
