/** Shared by the engine and editor. Quoted literals remain distinct from grammar words. */
export interface ScopeTarget {
  tag: string;
  index?: number;
  text?: string;
  inside?: ScopeTarget;
  where?: { column: string; value: string };
}
export type ScopeKey = { kind: 'attribute' | 'cell'; name: string };
export interface ScopeCommand {
  op: 'find' | 'ascend' | 'within' | 'each' | 'end' | 'expect' | 'click';
  target?: ScopeTarget;
  key?: ScopeKey;
  timeout?: number;
  condition?: 'visible' | 'enabled' | 'absent' | 'count' | 'text' | 'containsText' | 'nonempty' | 'attribute' | 'attributeContains';
  value?: string | number;
  attribute?: string;
}

const tags = new Set('main article section form table thead tbody tfoot tr row td th cell button link a input h1 h2 h3 h4 h5 h6 div span li ul ol current'.split(' '));
const commands = new Set(['find','ascend','within','each','expect','click']);
type Word = { value: string; literal: boolean };

export function readScopedCommand(input: string, start: number, name: string, inBlock: boolean, line: number):
    { command: ScopeCommand; end: number } | undefined {
  if (!commands.has(name)) return;
  if ((name === 'expect' || name === 'click') && !inBlock) {
    // Inspect only this statement. Hide quoted words so page copy cannot become syntax.
    const args = /^((?:"(?:\\.|[^"\\\r\n])*"|[^";\r\n])*)/.exec(input.slice(start))![1].trim();
    const quoted = /"(?:\\.|[^"\\])*"/g;
    const shape = args.replace(quoted, '#');
    const hasTimeout = /\s"timeout:\s*\d+"$/i.test(args);
    const indexed = /^[a-z]+[0-9]*\[/.test(shape);
    const selected = /^current\b/.test(shape);
    if (name === 'click') {
      if (!selected && !indexed && !(hasTimeout && /^(?:#|button|link|a|td|tr)(?: |$)/.test(shape))) return;
    } else {
      const countOrAbsent = /(?:^| )(?:equals length\.|absent(?: |$))/.test(shape);
      const textCheck = /^text .+ (?:not\.empty|equals #|contains #)(?: |$)/.test(shape);
      const attributeCheck = /^attribute .+ # (?:exists|contains #)(?: |$)/.test(shape);
      // The existing attribute command accepts selectors, spatial modifiers and typed links.
      // Its 'contains' form keeps the existing resolver unless a new target or option is used.
      if (name === 'expect' && /^attribute /.test(shape) && / contains #$/.test(shape) &&
          !hasTimeout && !/^attribute (?:current\b|cell\b|[a-z0-9]+\[)/.test(shape) &&
          !/ inside [a-z]/.test(shape)) return;
      const scopedState = /^(?:visible|enabled) (?:current\b|[a-z]+[0-9]*\[|h[1-6]\b|cell\b)/.test(shape) ||
        /^(?:visible|enabled) [a-z0-9]+$/.test(shape) || /^enabled /.test(shape);
      if (!countOrAbsent && !textCheck && !attributeCheck && !scopedState &&
          !(hasTimeout && /^(?:visible|enabled|text|attribute) /.test(shape))) return;
    }
  }
  const fail = (message: string): never => { throw new Error('Line ' + line + ': ' + message); };
  const words: Word[] = [];
  let pos = start;
  while (pos < input.length) {
    const c = input[pos];
    if (c === ' ' || c === '\t') { pos++; continue; }
    if (';\r\n{}'.includes(c) || input.startsWith('//', pos) || input.startsWith('/*', pos)) break;
    if (c === '"') {
      const match = /^"(?:\\.|[^"\\\r\n])*"/.exec(input.slice(pos));
      if (!match) return fail('Unclosed quoted scoped command argument.');
      let value: string;
      try { value = JSON.parse(match[0]); } catch { return fail('Invalid quoted scoped command argument.'); }
      words.push({ value, literal: true });
      pos += match[0].length;
    } else {
      const match = /^[^\s;{}"]+/.exec(input.slice(pos));
      if (!match) return fail('Invalid scoped command argument.');
      words.push({ value: match[0], literal: false });
      pos += match[0].length;
    }
  }
  let i = 0;
  const at = (s: string) => words[i]?.value === s && !words[i].literal;
  const take = (s: string) => { if (!at(s)) return false; i++; return true; };
  const literal = (what: string) => {
    if (!words[i]?.literal) return fail('Expected quoted ' + what + '.');
    return words[i++].value;
  };
  const timeoutOption = (n: number) => words[n]?.literal && /^timeout:/i.test(words[n].value);
  function target(): ScopeTarget {
    if (words[i]?.literal) {
      const textTarget: ScopeTarget = {tag:'text', text:literal('text')};
      if (take('inside')) textTarget.inside = target();
      return textTarget;
    }
    const word = words[i++];
    const part = /^([a-z][a-z0-9]*)(?:\[(\d+)\])?$/.exec(word?.value || '');
    if (!part || !tags.has(part[1])) return fail('Expected an element, current, or a zero-based element index.');
    const t: ScopeTarget = { tag: part[1] };
    if (t.tag === 'current' && part[2] !== undefined) return fail('current refers to one selected element.');
    if (part[2] !== undefined) {
      t.index = Number(part[2]);
      if (!Number.isSafeInteger(t.index)) return fail('Element index is too large.');
    }
    if (t.tag !== 'current' && t.index === undefined && words[i]?.literal &&
        !(timeoutOption(i) && i === words.length-1)) t.text = literal('element name');
    if (take('where')) {
      if (t.tag !== 'tr' && t.tag !== 'row' || !take('cell')) return fail('Use where cell on a row.');
      const column = literal('column heading');
      if (!take('equals')) return fail('Expected equals after the column heading.');
      t.where = { column, value:literal('cell value') };
    }
    if (take('inside')) {
      if (t.tag === 'current') return fail('current already has a scope.');
      t.inside = target();
    }
    return t;
  }
  const cmd: ScopeCommand = { op: name as ScopeCommand['op'] };
  if (name === 'expect') {
    if (take('attribute')) {
      cmd.target = target();
      cmd.attribute = literal('attribute name');
      if (take('exists')) cmd.condition = 'attribute';
      else if (take('contains')) { cmd.condition = 'attributeContains'; cmd.value = literal('attribute substring'); }
      else return fail('Use exists or contains after an attribute.');
    } else if (take('text')) {
      cmd.target = target();
      if (take('not.empty')) cmd.condition = 'nonempty';
      else if (take('equals')) { cmd.condition = 'text'; cmd.value = literal('expected text'); }
      else if (take('contains')) { cmd.condition = 'containsText'; cmd.value = literal('expected text'); }
      else return fail('Use equals, contains or not.empty after the text target.');
    } else if (at('visible') || at('enabled')) {
      cmd.condition = words[i++].value as 'visible' | 'enabled';
      cmd.target = target();
    } else {
      cmd.target = target();
      if (take('absent')) cmd.condition = 'absent';
      else {
        if (!take('equals')) return fail('Expected equals length.N or absent.');
        const length = words[i++];
        if (!length || length.literal || !/^length\.\d+$/.test(length.value)) return fail('Expected length.N with a nonnegative integer.');
        cmd.condition = 'count';
        cmd.value = Number(length.value.slice(7));
        if (!Number.isSafeInteger(cmd.value)) return fail('Expected a safe length.');
      }
    }
  } else if (name !== 'within') {
    cmd.target = target();
    if (name === 'ascend' && (cmd.target.tag === 'current' || cmd.target.tag === 'text' ||
        Object.keys(cmd.target).length !== 1)) return fail('ascend requires an ancestor element name.');
    if (name === 'each' && take('by')) {
      if (!at('attribute') && !at('cell')) return fail('Use by attribute or by cell.');
      const kind = words[i++].value as ScopeKey['kind'];
      const key = literal('iteration key');
      if (!key || kind === 'attribute' && !/^[a-zA-Z_][\w.:-]*$/.test(key)) return fail('Invalid iteration key.');
      cmd.key = {kind, name:key};
    }
  }
  if (timeoutOption(i)) {
    const match = /^timeout:\s*(\d+)$/i.exec(literal('timeout'));
    if (!match || +match[1] <= 0 || !Number.isSafeInteger(+match[1]) || +match[1] > 2147483647) return fail('Timeout must be a positive number of milliseconds up to 2147483647.');
    if (name === 'within') return fail('Put the timeout on the lookup or assertion inside within.');
    cmd.timeout = +match[1];
  }
  if (i !== words.length) return fail('Unexpected argument ' + JSON.stringify(words[i].value) + ' in flow.' + name + '.');
  if (name === 'within' || name === 'each') {
    while (/\s/.test(input[pos] || '!')) pos++;
    if (input[pos++] !== '{') return fail('Expected an opening brace after flow.' + name + '.');
  } else if (input[pos] === '{') return fail('Only within and each take a block.');
  return { command:cmd, end:pos };
}
