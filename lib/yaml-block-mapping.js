'use strict';

function mappingLines(content) {
  if (typeof content !== 'string') return null;
  const lines = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (
      line.includes('\r') ||
      line.includes('\t') ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(line)
    ) {
      return null;
    }
    if (/^ *(?:#.*)?$/.test(line)) continue;
    const indent = /^ */.exec(line)[0].length;
    lines.push({ indent, text: line.slice(indent) });
  }
  return lines;
}

function withoutInlineComment(rawValue) {
  let quote = null;
  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (quote === '"') {
      if (character === '\\') {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === '\'') {
      if (character === '\'' && rawValue[index + 1] === '\'') {
        index += 1;
      } else if (character === '\'') {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === '\'') {
      quote = character;
      continue;
    }
    if (character === '#' && (index === 0 || rawValue[index - 1] === ' ')) {
      return rawValue.slice(0, index).trimEnd();
    }
  }
  return rawValue.trimEnd();
}

function parseScalar(rawValue) {
  const value = withoutInlineComment(rawValue);
  if (value === '') return { kind: 'empty' };

  if (value.startsWith('"')) {
    try {
      const decoded = JSON.parse(value);
      if (typeof decoded !== 'string') return null;
      return { kind: 'scalar', style: 'quoted', value: decoded };
    } catch {
      return null;
    }
  }

  if (value.startsWith('\'')) {
    if (!/^'(?:[^']|'')*'$/.test(value)) return null;
    return {
      kind: 'scalar',
      style: 'quoted',
      value: value.slice(1, -1).replaceAll('\'\'', '\'')
    };
  }

  // Flow collections, block scalars, tags, anchors, and other YAML features are
  // outside the generated metadata subset. Reject them instead of approximating.
  if (
    /^[\-?:,\[\]{}#&*!|>'"%@`]/.test(value) ||
    /[\[\]{},'"]/.test(value) ||
    /:(?: |$)/.test(value)
  ) {
    return null;
  }
  return { kind: 'scalar', style: 'plain', value };
}

function parseMapping(lines, startIndex, indent) {
  const mapping = new Map();
  let index = startIndex;
  while (index < lines.length) {
    const line = lines[index];
    if (line.indent < indent) break;
    if (line.indent !== indent) return null;

    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line.text);
    if (!match || mapping.has(match[1])) return null;
    const suffix = match[2];
    if (suffix !== '' && !suffix.startsWith(' ')) return null;
    const value = parseScalar(suffix.trimStart());
    if (!value) return null;

    const key = match[1];
    index += 1;
    if (value.kind === 'empty') {
      if (index < lines.length && lines[index].indent > indent) {
        const child = parseMapping(lines, index, lines[index].indent);
        if (!child) return null;
        mapping.set(key, { kind: 'mapping', value: child.value });
        index = child.index;
      } else {
        mapping.set(key, { kind: 'null', value: null });
      }
      continue;
    }

    if (index < lines.length && lines[index].indent > indent) return null;
    mapping.set(key, value);
  }
  return { index, value: mapping };
}

function parseYamlBlockMapping(content) {
  const lines = mappingLines(content);
  if (!lines || lines.length === 0 || lines[0].indent !== 0) return null;
  const parsed = parseMapping(lines, 0, 0);
  if (!parsed || parsed.index !== lines.length) return null;
  return parsed.value;
}

module.exports = {
  parseYamlBlockMapping
};
