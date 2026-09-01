/**
 * Normalise an OpenAI `response_format` JSON schema so upstreams accept it.
 *
 * Structured outputs are stricter than the JSON Schema spec, and both upstreams
 * enforce it. A schema that omits `additionalProperties` is rejected outright
 * rather than defaulted:
 *
 *   OpenAI:    Invalid schema for response_format 'retrieval_schema':
 *              In context=(), 'additionalProperties' is required to be supplied
 *              and to be false.
 *   Anthropic: output_config.format.schema: For 'object' type,
 *              'additionalProperties' must be explicitly specified
 *
 * Plenty of clients emit schemas from a generic JSON Schema generator that has no
 * reason to include it -- WrenAI is one -- and they fail every request with a 400
 * that names a field the client author never wrote. Rather than make each of them
 * fix their generator, add the field on the way past.
 *
 * This is a narrowing, not a change of meaning: `additionalProperties: false` is
 * what strict mode requires and what the caller already gets when their schema is
 * accepted at all. The alternative to normalising is a 400.
 */

/** Recursively require `additionalProperties: false` on every object schema.
 *  Returns the number of mutations made. Counting rather than diffing the JSON
 *  matters: a schema may legitimately contain cycles via $defs/$ref, and
 *  JSON.stringify on one throws "Converting circular structure to JSON" -- which
 *  would turn a merely unusual request into a 500. */
function tighten(node: any, seen: Set<any>): number {
  if (node === null || typeof node !== "object") return 0;
  // Schemas can contain cycles via $defs/$ref; a plain recursive walk would hang.
  if (seen.has(node)) return 0;
  seen.add(node);

  let changed = 0;
  if (Array.isArray(node)) {
    node.forEach((n) => (changed += tighten(n, seen)));
    return changed;
  }

  // `type` may be a string or an array like ["object", "null"].
  const type = node.type;
  const isObject =
    type === "object" || (Array.isArray(type) && type.includes("object"));

  if (isObject && node.additionalProperties === undefined) {
    node.additionalProperties = false;
    changed++;
  }

  // Strict mode also requires every declared property to be listed in `required`.
  // Optionality is expressed by making the type nullable instead, so a schema that
  // omits this is rejected the same way -- and the error names `required`, not the
  // property that is missing from it.
  if (isObject && node.properties && typeof node.properties === "object") {
    const declared = Object.keys(node.properties);
    if (declared.length > 0) {
      const existing = Array.isArray(node.required) ? node.required : [];
      const missing = declared.filter((k) => !existing.includes(k));
      if (missing.length > 0) {
        node.required = [...existing, ...missing];
        changed++;
      }
    }
  }

  for (const key of Object.keys(node)) {
    changed += tighten(node[key], seen);
  }
  return changed;
}

/**
 * Mutates `body` in place. Returns true if anything was changed, so the caller can
 * log it -- a silently rewritten request is worse than a loud one when someone is
 * trying to work out why the model returned a shape they did not ask for.
 */
export function normalizeResponseFormat(body: any): boolean {
  const schema = body?.response_format?.json_schema?.schema;
  if (!schema || typeof schema !== "object") return false;

  const changed = tighten(schema, new Set());

  // `strict: true` is what actually turns on schema enforcement upstream. Without
  // it the schema is advisory, so a caller supplying a schema and getting
  // free-form text back is a surprise nobody wants.
  if (body.response_format.json_schema.strict === undefined) {
    body.response_format.json_schema.strict = true;
  }

  return changed > 0;
}
