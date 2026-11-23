import type { Frame, Locator, Page } from 'playwright';
import type { ScopeCommand, ScopeTarget, ScopeKey } from '../parser/scoped';
import { assertBrowser } from './assertions';
import { poll } from './validation';
import type { AssertionReporter } from '../reporting/assertion_result';

type Root = Page | Frame | Locator;
interface Selection { locator: Locator; label: string }
interface Block {
  previous?: Selection;
  parent?: Selection;
  item: Selection;
  first: number;
  index: number;
  size: number;
  collection?: Locator;
  row?: boolean;
  keys?: string[];
  key?: ScopeKey;
  label: string;
}

function xpathString(value: string): string {
  if (!value.includes("'")) return "'" + value + "'";
  return 'concat(' + value.split("'").map(part => "'" + part + "'").join(', "\'", ') + ')';
}

// Resolve relative to each cell's own table on every lookup, including after a redraw.
function columnCells(name: string): string {
  const header = 'ancestor::table[1]/thead/tr/th[normalize-space(.)=' + xpathString(name) + ']';
  const preceding = 'preceding-sibling::*[self::td or self::th]';
  const offset = (path: string) => 'count(' + path + '[not(@colspan)]) + sum(' + path + '/@colspan)';
  const associated = header + '[@id and string-length(@id)>0]';
  return 'td[count(' + header + ')=1 and ((@headers and ' + associated +
    ' and contains(concat(" ",normalize-space(@headers)," "),concat(" ",string(' + associated + '/@id)," "))) or ' +
    '(not(@headers) and ' + offset(preceding) + ' = ' + offset(header + '/' + preceding) + '))]';
}

function keyExpression(key: ScopeKey): string {
  return key.kind === 'attribute' ? '@' + key.name : columnCells(key.name);
}
function tagName(tag: string): string {
  return ({row:'tr',cell:'td',link:'a'} as Record<string,string>)[tag] || tag;
}
function description(target: ScopeTarget): string {
  return target.tag + (target.index !== undefined ? '[' + target.index + ']' : '') +
    (target.text !== undefined ? ' ' + JSON.stringify(target.text) : '') +
    (target.where ? ' where ' + target.where.column + ' equals ' + JSON.stringify(target.where.value) : '');
}

export class ScopedBrowser {
  private active?: Selection;
  private scope?: Selection;
  private blocks: Block[] = [];
  constructor(private readonly root: () => Page | Frame, private readonly page: () => Page,
              private readonly defaultTimeout: number) {}

  get iterationId(): string {
    const iterations = this.blocks.filter(block => block.collection);
    return iterations.some(block => block.index > 0) ? iterations.map(block => '_row' + (block.index + 1)).join('') : '';
  }
  private lookup(target: ScopeTarget): Selection {
    if (target.tag === 'current') {
      if (!this.active) throw new Error('current requires a selected element. Use flow.find first.');
      return this.active;
    }
    const bound = target.inside ? this.lookup(target.inside) : this.scope;
    const base: Root = bound?.locator || this.root();
    const tag = tagName(target.tag);
    let locator: Locator;
    if (target.tag === 'text') locator = base.getByText(target.text!, {exact:true});
    else if (target.tag === 'cell' && target.text !== undefined) {
      locator = base.locator('xpath=./' + columnCells(target.text));
    } else if (target.text?.startsWith('#') && target.tag === 'table') {
      locator = base.locator('xpath=.//table[@id=' + xpathString(target.text.slice(1)) + ']');
    } else if ((tag === 'button' || tag === 'a') && target.text !== undefined) {
      locator = base.getByRole(tag === 'a' ? 'link' : 'button', {name:target.text, exact:true});
    } else {
      let path = './/' + tag;
      if (target.text !== undefined) path += '[normalize-space(.)=' + xpathString(target.text) + ']';
      if (target.where) path += '[' + columnCells(target.where.column) + '[normalize-space(.)=' + xpathString(target.where.value) + ']]';
      locator = base.locator('xpath=' + path);
    }
    if (target.index !== undefined) locator = locator.nth(target.index);
    return {locator, label:[bound?.label, description(target)].filter(Boolean).join(' → ')};
  }

  private async requireOne(selection: Selection, timeout: number) {
    let count = 0;
    try {
      await poll(async () => {
        count = await selection.locator.count();
        return count === 1;
      }, timeout, selection.label);
    } catch {
      throw new Error(selection.label + ': expected one match, found ' + count + ' after ' + timeout +
        ' ms.' + (count > 1 ? ' Narrow the target or use a zero-based index.' : ''));
    }
  }

  private async snapshot(collection: Locator, key: ScopeKey | undefined, timeout: number, label: string) {
    let size = 0, keys: string[] | undefined;
    const path = key && keyExpression(key);
    await poll(async () => {
      if (path) {
        keys = await collection.evaluateAll((rows, expression) => rows.map(row => {
          const result = row.ownerDocument.evaluate(expression,row,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
          if (result.snapshotLength !== 1) return '';
          return (result.snapshotItem(0)?.textContent || '').replace(/[\t\n\r ]+/g, ' ').replace(/^ | $/g, '');
        }), path);
        size = keys.length;
      } else size = await collection.count();
      return size > 0;
    }, timeout, label + ': expected at least one item for each');
    if (keys && (keys.some(value => !value) || new Set(keys).size !== size)) {
      throw new Error(label + ': each requires one nonempty, unique key per original row.');
    }
    return {size, keys};
  }

  private selectItem(block: Block): Selection {
    const source = block.collection!;
    const position = block.index + 1;
    const label = block.label + ' → ' + (block.row ? 'row ' : 'item ') + position + ' of ' + block.size;
    let locator = source.nth(block.index);
    if (block.key && block.keys) {
      const key = keyExpression(block.key);
      locator = source.locator('xpath=self::*[normalize-space(' + key + ')=' + xpathString(block.keys[block.index]) + ']');
    }
    return {locator, label};
  }

  async execute(cmd: ScopeCommand, position: number, reporter?: AssertionReporter): Promise<number | undefined> {
    const timeout = cmd.timeout ?? this.defaultTimeout;
    if (cmd.op === 'end') {
      const block = this.blocks.at(-1);
      if (!block) throw new Error('Unexpected end of scope.');
      if (block.collection && ++block.index < block.size) {
        if (!block.key && await block.collection.count() !== block.size) {
          throw new Error(block.label + ': collection changed during each. Use by attribute or by cell to track records.');
        }
        block.item = this.selectItem(block);
        await this.requireOne(block.item, timeout);
        this.active = this.scope = block.item;
        return block.first;
      }
      this.blocks.pop();
      this.active = block.previous;
      this.scope = block.parent;
      return;
    }
    if (cmd.op === 'within' || cmd.op === 'each') {
      const selection = cmd.op === 'each' ? this.lookup(cmd.target!) : this.active;
      if (!selection) throw new Error('within requires a selected element. Use flow.find first.');
      const block: Block = { previous:this.active, parent:this.scope, item:selection, first:position + 1,
        index:0, size:1, label:selection.label };
      if (cmd.op === 'each') {
        Object.assign(block, await this.snapshot(selection.locator, cmd.key, timeout, selection.label));
        block.collection = selection.locator;
        block.key = cmd.key;
        block.row = ['row', 'tr'].includes(cmd.target!.tag);
        block.item = this.selectItem(block);
      }
      await this.requireOne(block.item, timeout);
      this.blocks.push(block);
      this.active = this.scope = block.item;
      return;
    }
    let selection: Selection;
    if (cmd.op === 'ascend') {
      if (!this.active) throw new Error('ascend requires a selected element. Use flow.find first.');
      selection = {locator:this.active.locator.locator('xpath=ancestor::' + tagName(cmd.target!.tag) + '[1]'),
        label:this.active.label + ' → enclosing ' + cmd.target!.tag};
    } else selection = this.lookup(cmd.target!);
    if (cmd.op === 'find' || cmd.op === 'ascend') {
      await this.requireOne(selection, timeout);
      this.active = selection;
    } else if (cmd.op === 'click') {
      // Playwright re-resolves the locator and checks actionability; dispatch the action once.
      await selection.locator.click({timeout});
    } else {
      const condition = cmd.condition!;
      const data: Record<string,unknown> = {selector:selection.label, timeout, condition, value:cmd.value};
      if (condition === 'absent') Object.assign(data, {condition:'count',value:0});
      if (condition === 'nonempty') Object.assign(data, {condition:'text',matches:'\\S'});
      if (condition === 'attribute' || condition === 'attributeContains') {
        data.attribute = cmd.attribute;
        data.condition = 'attribute';
        if (condition === 'attributeContains') {
          data.matches = String(cmd.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          delete data.value;
        }
      }
      await assertBrowser(this.page(), data, timeout, reporter, undefined, selection.locator);
    }
    return;
  }
}
