const DECIMAL_NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * @param {string | undefined} body
 * @returns {Record<string, any>}
 */
export function extractToolInputSchemas(body) {
  if (typeof body !== "string" || !body.trim()) return {};

  try {
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.tools)) return {};

    return Object.fromEntries(
      parsed.tools
        .filter(
          (tool) => tool && typeof tool.name === "string" && tool.input_schema && typeof tool.input_schema === "object",
        )
        .map((tool) => [tool.name, tool.input_schema]),
    );
  } catch {
    return {};
  }
}

/**
 * @param {any} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {any} schema
 * @returns {string[]}
 */
function getSchemaTypes(schema) {
  if (!schema) return [];
  if (Array.isArray(schema.type)) return schema.type.filter((value) => typeof value === "string");
  return typeof schema.type === "string" ? [schema.type] : [];
}

/**
 * @param {any} value
 * @param {any} schema
 * @returns {boolean}
 */
function schemaAcceptsCurrentType(value, schema) {
  if (!schema) return false;

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.every((item) => schemaAcceptsCurrentType(value, item));
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.some((item) => schemaAcceptsCurrentType(value, item));
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.some((item) => schemaAcceptsCurrentType(value, item));
  }

  const types = getSchemaTypes(schema);
  if (types.length === 0) return false;

  if (value === null) return types.includes("null");
  if (typeof value === "string") return types.includes("string");
  if (typeof value === "boolean") return types.includes("boolean");
  if (typeof value === "number") {
    if (Number.isInteger(value) && types.includes("integer")) return true;
    return types.includes("number");
  }
  if (Array.isArray(value)) return types.includes("array");
  if (isPlainObject(value)) return types.includes("object");

  return false;
}

/**
 * @param {any} value
 * @param {any[]} variants
 * @returns {any}
 */
function coerceUsingVariants(value, variants) {
  for (const variant of variants) {
    if (schemaAcceptsCurrentType(value, variant)) return value;
  }

  for (const variant of variants) {
    const coerced = coerceToolInputValue(value, variant);
    if (JSON.stringify(coerced) !== JSON.stringify(value)) return coerced;
  }
  return value;
}

/**
 * @param {any} value
 * @param {any} schema
 * @returns {any}
 */
function coerceToolInputValue(value, schema) {
  if (!schema || value == null) return value;

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return schema.allOf.reduce((current, item) => coerceToolInputValue(current, item), value);
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return coerceUsingVariants(value, schema.anyOf);
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return coerceUsingVariants(value, schema.oneOf);
  }

  const types = getSchemaTypes(schema);

  if (schemaAcceptsCurrentType(value, schema) && !isPlainObject(value) && !Array.isArray(value)) {
    return value;
  }

  if (typeof value === "string") {
    if ((types.includes("integer") || types.includes("number")) && DECIMAL_NUMBER_PATTERN.test(value)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && (!types.includes("integer") || Number.isInteger(parsed))) {
        return parsed;
      }
    }

    if (types.includes("boolean")) {
      if (value === "true") return true;
      if (value === "false") return false;
    }

    if (types.includes("object") || types.includes("array")) {
      try {
        const parsed = JSON.parse(value);
        return coerceToolInputValue(parsed, schema);
      } catch {
        return value;
      }
    }
  }

  if (Array.isArray(value) && (types.includes("array") || schema.items)) {
    return value.map((item) => coerceToolInputValue(item, schema.items));
  }

  if (isPlainObject(value) && (types.includes("object") || isPlainObject(schema.properties))) {
    const next = { ...value };
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    const additional = isPlainObject(schema.additionalProperties) ? schema.additionalProperties : null;

    for (const [key, childValue] of Object.entries(next)) {
      const childSchema = properties[key] ?? additional;
      if (childSchema) next[key] = coerceToolInputValue(childValue, childSchema);
    }

    return next;
  }

  return value;
}

/**
 * @param {Record<string, any>} args
 * @param {any} schema
 * @returns {boolean}
 */
export function coerceToolArgsInPlace(args, schema) {
  if (!isPlainObject(args) || !schema) return false;

  const normalized = coerceToolInputValue(args, schema);
  if (!isPlainObject(normalized)) return false;
  if (JSON.stringify(normalized) === JSON.stringify(args)) return false;

  for (const [key, value] of Object.entries(normalized)) {
    args[key] = value;
  }

  return true;
}
