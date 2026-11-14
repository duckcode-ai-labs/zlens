import { z } from 'zod';
import { getDqlToolDefinition, type DqlToolName, type JsonSchema } from '@zlens/agent';

export function zodInputShapeForTool(name: DqlToolName): Record<string, z.ZodTypeAny> {
  return zodRawShapeFromJsonSchema(getDqlToolDefinition(name).inputSchema);
}

export function zodRawShapeFromJsonSchema(schema: JsonSchema): Record<string, z.ZodTypeAny> {
  const properties = jsonObject(schema.properties);
  const required = new Set(jsonStringList(schema.required));
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    const field = zodTypeFromJsonSchema(propertySchema);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function zodTypeFromJsonSchema(schema: unknown): z.ZodTypeAny {
  const record = jsonObject(schema);
  const enumValues = jsonStringList(record.enum);
  let type: z.ZodTypeAny;
  if (enumValues.length > 0) {
    type = z.enum(enumValues as [string, ...string[]]);
  } else if (record.type === 'string') {
    type = applyStringBounds(z.string(), record);
  } else if (record.type === 'number' || record.type === 'integer') {
    type = applyNumberBounds(record.type === 'integer' ? z.number().int() : z.number(), record);
  } else if (record.type === 'boolean') {
    type = z.boolean();
  } else if (record.type === 'array') {
    type = applyArrayBounds(z.array(zodTypeFromJsonSchema(record.items)), record);
  } else if (record.type === 'object') {
    const properties = jsonObject(record.properties);
    if (Object.keys(properties).length > 0) {
      const required = new Set(jsonStringList(record.required));
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [key, propertySchema] of Object.entries(properties)) {
        const field = zodTypeFromJsonSchema(propertySchema);
        shape[key] = required.has(key) ? field : field.optional();
      }
      type = record.additionalProperties === false ? z.object(shape).strict() : z.object(shape);
    } else if (record.additionalProperties && typeof record.additionalProperties === 'object') {
      type = z.record(z.string(), zodTypeFromJsonSchema(record.additionalProperties));
    } else {
      type = z.record(z.string(), z.unknown());
    }
  } else {
    type = z.unknown();
  }

  const description = typeof record.description === 'string' ? record.description.trim() : '';
  return description ? type.describe(description) : type;
}

function applyArrayBounds(type: z.ZodArray<z.ZodTypeAny>, record: Record<string, unknown>): z.ZodTypeAny {
  const minItems = finiteInteger(record.minItems);
  const maxItems = finiteInteger(record.maxItems);
  let bounded: z.ZodTypeAny = type;
  if (minItems !== undefined) bounded = (bounded as z.ZodArray<z.ZodTypeAny>).min(minItems);
  if (maxItems !== undefined) bounded = (bounded as z.ZodArray<z.ZodTypeAny>).max(maxItems);
  return bounded;
}

function applyNumberBounds(type: z.ZodNumber, record: Record<string, unknown>): z.ZodTypeAny {
  const minimum = finiteNumber(record.minimum);
  const maximum = finiteNumber(record.maximum);
  let bounded: z.ZodTypeAny = type;
  if (minimum !== undefined) bounded = (bounded as z.ZodNumber).min(minimum);
  if (maximum !== undefined) bounded = (bounded as z.ZodNumber).max(maximum);
  return bounded;
}

function applyStringBounds(type: z.ZodString, record: Record<string, unknown>): z.ZodTypeAny {
  const minLength = finiteInteger(record.minLength);
  const maxLength = finiteInteger(record.maxLength);
  let bounded: z.ZodTypeAny = type;
  if (minLength !== undefined) bounded = (bounded as z.ZodString).min(minLength);
  if (maxLength !== undefined) bounded = (bounded as z.ZodString).max(maxLength);
  return bounded;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function jsonStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}
