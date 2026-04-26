// schema-validator.js — hand-rolled JSON-Schema validator (no external deps in v0.01).
// Supported subset (TDD §4): type, required, properties, additionalProperties:false, pattern,
// enum, const, items, minItems, oneOf discriminated by literal `type`, and intra-doc $ref.
// TDD: §4, §9
// Tasks: T-202
// Wave: 1
// Status: implemented (Wave 2)

const ALLOWED_SCHEMA_KEYS = new Set([
  'type',
  'required',
  'properties',
  'additionalProperties',
  'pattern',
  'enum',
  'const',
  'items',
  'minItems',
  'oneOf',
  '$ref',
  'definitions',
]);

/**
 * @param {unknown} schemaRoot
 * @param {string} ptr
 */
function assertSupportedKeywords(schemaRoot, ptr) {
  if (schemaRoot === null || typeof schemaRoot !== 'object') return;
  if (Array.isArray(schemaRoot)) {
    schemaRoot.forEach((item, i) => assertSupportedKeywords(item, `${ptr}/${i}`));
    return;
  }
  for (const key of Object.keys(schemaRoot)) {
    if (key === '$ref') continue;
    if (!ALLOWED_SCHEMA_KEYS.has(key)) {
      throw new Error(`schema feature not supported in v0.01: ${key}`);
    }
  }
  if (schemaRoot.properties && typeof schemaRoot.properties === 'object') {
    for (const p of Object.keys(schemaRoot.properties)) {
      assertSupportedKeywords(schemaRoot.properties[p], `${ptr}/properties/${p}`);
    }
  }
  if (schemaRoot.items) {
    assertSupportedKeywords(schemaRoot.items, `${ptr}/items`);
  }
  if (Array.isArray(schemaRoot.oneOf)) {
    schemaRoot.oneOf.forEach((branch, i) =>
      assertSupportedKeywords(branch, `${ptr}/oneOf/${i}`),
    );
  }
  if (schemaRoot.definitions && typeof schemaRoot.definitions === 'object') {
    for (const d of Object.keys(schemaRoot.definitions)) {
      assertSupportedKeywords(schemaRoot.definitions[d], `${ptr}/definitions/${d}`);
    }
  }
  if (
    schemaRoot.additionalProperties &&
    typeof schemaRoot.additionalProperties === 'object'
  ) {
    assertSupportedKeywords(
      schemaRoot.additionalProperties,
      `${ptr}/additionalProperties`,
    );
  }
}

/**
 * @param {object} root
 * @param {string} ref
 */
function resolveRef(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#')) {
    throw new Error('schema feature not supported in v0.01: external $ref');
  }
  const segments = ref
    .slice(1)
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur = root;
  for (const seg of segments) {
    if (cur === undefined || typeof cur !== 'object') {
      throw new Error(`$ref not found: ${ref}`);
    }
    cur = cur[seg];
  }
  if (cur === undefined) {
    throw new Error(`$ref not found: ${ref}`);
  }
  return cur;
}

/**
 * @param {object} branch
 * @param {object} root
 * @returns {string|undefined}
 */
function discriminantConstForOneOfBranch(branch, root) {
  let node = branch;
  if (node && typeof node === 'object' && node.$ref) {
    node = resolveRef(root, node.$ref);
  }
  const t = node.properties && node.properties.type;
  if (!t || typeof t !== 'object') return undefined;
  if (!Object.prototype.hasOwnProperty.call(t, 'const')) return undefined;
  return typeof t.const === 'string' ? t.const : undefined;
}

/**
 * @param {object} schemaNode
 * @param {object} oneOfSchema
 * @param {object} root
 * @returns {object}
 */
function pickOneOfBranch(schemaNode, oneOfSchema, root) {
  const branches = oneOfSchema.oneOf;
  if (!Array.isArray(branches) || branches.length === 0) {
    throw new Error('invalid oneOf');
  }
  const typeVal =
    schemaNode && typeof schemaNode === 'object' && !Array.isArray(schemaNode)
      ? schemaNode.type
      : undefined;
  if (typeof typeVal !== 'string') {
    return { branch: null, reason: 'missing discriminator field "type"' };
  }
  const map = new Map();
  for (const br of branches) {
    const c = discriminantConstForOneOfBranch(br, root);
    if (c !== undefined) {
      map.set(c, br);
    }
  }
  const picked = map.get(typeVal);
  if (!picked) {
    return { branch: null, reason: `no oneOf branch for type "${typeVal}"` };
  }
  return { branch: picked };
}

/**
 * @param {unknown} value
 * @param {string} jsonType
 */
function matchesJsonType(value, jsonType) {
  switch (jsonType) {
    case 'null':
      return value === null;
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isFinite(value) && value % 1 === 0;
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return value !== null && typeof value === 'object' && !Array.isArray(value);
    default:
      return false;
  }
}

/**
 * @param {unknown} value
 * @param {string|string[]} typeSchema
 */
function matchesType(value, typeSchema) {
  if (Array.isArray(typeSchema)) {
    return typeSchema.some((t) => matchesJsonType(value, t));
  }
  return matchesJsonType(value, typeSchema);
}

/**
 * @param {object} schemaNode
 * @param {unknown} value
 * @param {string} path
 * @param {object} root
 * @param {{ path: string, code: string, message: string }[]} errors
 * @returns {boolean}
 */
function validateAgainst(schemaNode, value, path, root, errors) {
  if (schemaNode && typeof schemaNode === 'object' && '$ref' in schemaNode) {
    const ref = schemaNode.$ref;
    const resolved = resolveRef(root, ref);
    return validateAgainst(resolved, value, path, root, errors);
  }

  if (schemaNode && typeof schemaNode === 'object' && Array.isArray(schemaNode.oneOf)) {
    const { branch, reason } = pickOneOfBranch(value, schemaNode, root);
    if (!branch) {
      errors.push({
        path,
        code: 'oneOf',
        message: reason || 'no matching oneOf branch',
      });
      return false;
    }
    const resolvedBranch =
      branch.$ref !== undefined ? resolveRef(root, branch.$ref) : branch;
    return validateAgainst(resolvedBranch, value, path, root, errors);
  }

  if (!schemaNode || typeof schemaNode !== 'object') {
    errors.push({ path, code: 'schema', message: 'invalid schema node' });
    return false;
  }

  if (schemaNode.type !== undefined) {
    if (!matchesType(value, schemaNode.type)) {
      errors.push({
        path,
        code: 'type',
        message: `expected type ${JSON.stringify(schemaNode.type)}`,
      });
      return false;
    }
  }

  if (Object.prototype.hasOwnProperty.call(schemaNode, 'const')) {
    if (value !== schemaNode.const) {
      errors.push({
        path,
        code: 'const',
        message: `expected const ${JSON.stringify(schemaNode.const)}`,
      });
      return false;
    }
  }

  if (schemaNode.enum) {
    if (!Array.isArray(schemaNode.enum) || !schemaNode.enum.includes(value)) {
      errors.push({
        path,
        code: 'enum',
        message: 'value not in enum',
      });
      return false;
    }
  }

  if (schemaNode.pattern !== undefined) {
    if (typeof value !== 'string') {
      errors.push({ path, code: 'pattern', message: 'pattern requires string value' });
      return false;
    }
    const re = new RegExp(schemaNode.pattern);
    if (!re.test(value)) {
      errors.push({
        path,
        code: 'pattern',
        message: `string does not match pattern ${schemaNode.pattern}`,
      });
      return false;
    }
  }

  if (schemaNode.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push({ path, code: 'type', message: 'expected array' });
      return false;
    }
    if (
      schemaNode.minItems !== undefined &&
      value.length < schemaNode.minItems
    ) {
      errors.push({
        path,
        code: 'minItems',
        message: `array shorter than minItems ${schemaNode.minItems}`,
      });
      return false;
    }
    if (schemaNode.items) {
      for (let i = 0; i < value.length; i++) {
        const itemOk = validateAgainst(
          schemaNode.items,
          value[i],
          `${path}/${i}`,
          root,
          errors,
        );
        if (!itemOk) return false;
      }
    }
    return true;
  }

  if (schemaNode.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push({ path, code: 'type', message: 'expected object' });
      return false;
    }
    const req = schemaNode.required;
    if (Array.isArray(req)) {
      for (const key of req) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          errors.push({
            path: `${path}/${key}`,
            code: 'required',
            message: 'missing required property',
          });
          return false;
        }
      }
    }
    const props = schemaNode.properties;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(value)) {
        if (Object.prototype.hasOwnProperty.call(props, key)) {
          const ok = validateAgainst(
            props[key],
            value[key],
            `${path}/${key}`,
            root,
            errors,
          );
          if (!ok) return false;
        } else if (schemaNode.additionalProperties === false) {
          errors.push({
            path: `${path}/${key}`,
            code: 'additionalProperties',
            message: 'additional properties not allowed',
          });
          return false;
        } else if (
          schemaNode.additionalProperties &&
          typeof schemaNode.additionalProperties === 'object'
        ) {
          const ok = validateAgainst(
            schemaNode.additionalProperties,
            value[key],
            `${path}/${key}`,
            root,
            errors,
          );
          if (!ok) return false;
        }
      }
    } else {
      for (const key of Object.keys(value)) {
        if (schemaNode.additionalProperties === false) {
          errors.push({
            path: `${path}/${key}`,
            code: 'additionalProperties',
            message: 'additional properties not allowed',
          });
          return false;
        }
      }
    }
    return true;
  }

  return true;
}

/**
 * @param {object} schema
 * @param {unknown} value
 * @returns {{ valid: true } | { valid: false, errors: { path: string, code: string, message: string }[] }}
 */
export function validate(schema, value) {
  if (!schema || typeof schema !== 'object') {
    throw new Error('schema must be a non-null object');
  }
  assertSupportedKeywords(schema, '#');
  /** @type {{ path: string, code: string, message: string }[]} */
  const errors = [];
  const ok = validateAgainst(schema, value, '#', schema, errors);
  if (ok && errors.length === 0) return { valid: true };
  return { valid: false, errors: errors.length > 0 ? errors : [{ path: '#', code: 'invalid', message: 'validation failed' }] };
}

/**
 * @param {Record<string, never>} [_opts]
 */
export function bindToChrome(_opts) {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
}
