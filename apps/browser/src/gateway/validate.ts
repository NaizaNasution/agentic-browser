// Validates request params and ctx against the protocol schema (packages/protocol/schema/protocol.json).
// Unknown properties are ignored, so a newer client with an extra optional field still works (same major version).
import { TYPE_SCHEMAS, type TypeSchema } from "@agb/protocol";

/** Returns a message describing the first problem, or null if `value` matches `schema`. */
export function validate(value: unknown, schema: TypeSchema | string, path = "params"): string | null {
  const s = typeof schema === "string" ? TYPE_SCHEMAS[schema] : schema.$ref ? TYPE_SCHEMAS[schema.$ref] : schema;
  if (!s) return `${path}: unknown type ${typeof schema === "string" ? schema : schema.$ref}`;

  if (s.enum) {
    if (typeof value !== "string" || !s.enum.includes(value)) return `${path} must be one of ${s.enum.join(", ")}`;
    return null;
  }
  switch (s.type) {
    case "string":
      if (typeof value !== "string") return `${path} must be a string`;
      if (s.minLength !== undefined && value.length < s.minLength) {
        return s.minLength === 1 ? `${path} must not be empty` : `${path} must be at least ${s.minLength} characters`;
      }
      if (s.maxLength !== undefined && value.length > s.maxLength) return `${path} is longer than ${s.maxLength} characters`;
      return null;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number`;
      if (s.type === "integer" && !Number.isInteger(value)) return `${path} must be a whole number`;
      if (s.minimum !== undefined && value < s.minimum) return `${path} must be at least ${s.minimum}`;
      if (s.maximum !== undefined && value > s.maximum) return `${path} must be at most ${s.maximum}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${path} must be true or false`;
    case "array": {
      if (!Array.isArray(value)) return `${path} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const err = s.items ? validate(value[i], s.items, `${path}[${i}]`) : null;
        if (err) return err;
      }
      return null;
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const key of s.required ?? []) {
        if (obj[key] === undefined) return `${path}.${key} is required`;
      }
      for (const [key, prop] of Object.entries(s.properties ?? {})) {
        if (obj[key] === undefined) continue;
        const err = validate(obj[key], prop, `${path}.${key}`);
        if (err) return err;
      }
      return null;
    }
    default:
      return `${path}: unsupported schema`;
  }
}
