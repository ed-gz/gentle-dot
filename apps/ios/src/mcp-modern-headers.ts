/** Safe, bounded MCP 2026 `x-mcp-header` extraction. Call only after
 * validating the complete schema and arguments; this never makes a request. */
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type HeaderField = { name: string; path: string[]; kind: 'string' | 'integer' | 'boolean'; nullable: boolean };

function headerValue(value: string): string {
  // Reject lone UTF-16 surrogates rather than allow lossy UTF-8 conversion.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Texto de cabecera MCP inválido.');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw new Error('Texto de cabecera MCP inválido.');
  }
  const direct = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !(value.startsWith('=?base64?') && value.endsWith('?='));
  const data = new TextEncoder().encode(value);
  if (data.length > 12000) throw new Error('Cabecera MCP demasiado grande.');
  let encoded = value;
  if (!direct) {
    let binary = ''; for (const byte of data) binary += String.fromCharCode(byte);
    encoded = `=?base64?${btoa(binary)}?=`;
  }
  if (encoded.length > 16 * 1024) throw new Error('Cabecera MCP demasiado grande.');
  return encoded;
}

/** Returns only Mcp-Param-* headers, never arbitrary HTTP header names. */
export function modernMCPParameterHeaders(schema: Record<string, unknown>, args: Record<string, unknown>): Record<string, string> {
  const fields: HeaderField[] = [], seen = new Set<string>(); let nodes = 0;
  function visit(rule: unknown, path: string[], reachable: boolean, depth: number): void {
    if (++nodes > 2000 || depth > 24) throw new Error('Esquema de cabeceras MCP demasiado complejo.');
    if (typeof rule === 'boolean') return;
    if (!object(rule)) throw new Error('Esquema de cabeceras MCP inválido.');
    const hasRef = Object.hasOwn(rule, '$ref');
    if (Object.hasOwn(rule, 'x-mcp-header')) {
      const name = rule['x-mcp-header'];
      const declared = Array.isArray(rule.type) ? rule.type : [rule.type];
      const kinds = declared.filter(kind => kind !== 'null');
      if (!reachable || !path.length || hasRef || typeof name !== 'string' || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,118}$/.test(name) ||
          seen.has(name.toLowerCase()) || kinds.length !== 1 || !['string','integer','boolean'].includes(String(kinds[0])) ||
          declared.length !== kinds.length + (declared.includes('null') ? 1 : 0) || fields.length >= 24)
        throw new Error('Anotación x-mcp-header no válida.');
      seen.add(name.toLowerCase()); fields.push({ name, path, kind:kinds[0] as HeaderField['kind'], nullable:declared.includes('null') });
    }
    if (object(rule.properties)) for (const [key, child] of Object.entries(rule.properties)) visit(child, [...path, key], reachable && !hasRef, depth + 1);
    for (const key of ['$defs','definitions']) if (object(rule[key])) for (const child of Object.values(rule[key])) visit(child, path, false, depth + 1);
    for (const key of ['items','additionalProperties']) if (rule[key] !== undefined) visit(rule[key], path, false, depth + 1);
    for (const key of ['allOf','anyOf','oneOf']) if (Array.isArray(rule[key])) for (const child of rule[key]) visit(child, path, false, depth + 1);
  }
  visit(schema, [], true, 0);
  const headers: Record<string, string> = {};
  for (const field of fields) {
    let value: unknown = args;
    for (const key of field.path) {
      if (!object(value) || !Object.hasOwn(value, key)) { value = undefined; break; }
      value = value[key];
    }
    if (value === undefined || value === null && field.nullable) continue;
    if (field.kind === 'string' ? typeof value !== 'string' : field.kind === 'boolean' ? typeof value !== 'boolean' : !Number.isSafeInteger(value))
      throw new Error('El valor de cabecera MCP no corresponde al esquema.');
    headers[`Mcp-Param-${field.name}`] = headerValue(String(value));
  }
  return headers;
}
