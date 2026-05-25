import { z } from "zod";

/**
 * Boolean schema that tolerates the harness wire-format for booleans.
 *
 * Background (GH-1130): When a ralph-hero MCP tool is invoked before its
 * schema has been hydrated by Claude Code's `ToolSearch`, the harness
 * passes boolean argument values through as the literal strings `"true"`
 * or `"false"` instead of the native boolean primitives. A plain
 * `z.boolean()` schema rejects those strings with `"Expected boolean,
 * received string"`, producing MCP error -32602 and forcing the caller
 * to round-trip through `ToolSearch` before the call can succeed.
 *
 * `z.coerce.boolean()` is NOT a safe replacement: it uses the JavaScript
 * `Boolean()` constructor, and `Boolean("false") === true` because any
 * non-empty string is truthy. That would silently flip every `"false"`
 * arrival into `true`.
 *
 * `zBoolish` uses `z.preprocess` to map only the two exact literal
 * strings the harness emits (`"true"` → `true`, `"false"` → `false`)
 * before handing off to a real `z.boolean()` validator. Anything else
 * (numbers, objects, `"yes"`, `"1"`, etc.) is passed through unchanged
 * and rejected with the standard boolean error message. Native booleans
 * pass through unchanged.
 *
 * @example
 *   const Schema = z.object({ flag: zBoolish().optional().default(false) });
 *   Schema.parse({ flag: true })     // { flag: true }
 *   Schema.parse({ flag: "true" })   // { flag: true }
 *   Schema.parse({ flag: "false" })  // { flag: false }
 *   Schema.parse({ flag: "yes" })    // throws ZodError
 */
export function zBoolish() {
  return z.preprocess((value) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  }, z.boolean());
}
