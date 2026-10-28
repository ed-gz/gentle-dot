/** Small, deliberately bounded Markdown subset. HTML, images and links remain
 * literal text: a model response cannot navigate, fetch a resource or execute. */
export type ReplyInline = { kind: 'text' | 'strong' | 'em' | 'code'; text: string };
export type ReplyBlock = { kind: 'paragraph' | 'heading' | 'quote'; text: string }
  | { kind: 'code'; text: string; language: string }
  | { kind: 'list'; ordered: boolean; start: number; items: string[] };

export function replyInline(text: string): ReplyInline[] {
  const result: ReplyInline[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index!;
    if (at > offset) result.push({ kind: 'text', text: text.slice(offset, at) });
    const token = match[0];
    const kind = token.startsWith('`') ? 'code' : token.startsWith('**') ? 'strong' : 'em';
    const cut = kind === 'strong' ? 2 : 1;
    result.push({ kind, text: token.slice(cut, -cut) });
    offset = at + token.length;
  }
  if (offset < text.length) result.push({ kind: 'text', text: text.slice(offset) });
  return result;
}

export function replyBlocks(text: string): ReplyBlock[] {
  // The conversation store caps each message at 32k. Unexpected larger input
  // remains plain and complete instead of being silently truncated.
  if (text.length > 32000) return [{ kind: 'paragraph', text }];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReplyBlock[] = [];
  const listItem = (line: string) => /^(?:([-+*]) |(\d{1,6})[.)] )(.+)$/.exec(line);
  const special = (line: string) => !line.trim() || /^```/.test(line) || /^(#{1,6})\s/.test(line) || /^> ?/.test(line) || !!listItem(line);
  for (let i = 0; i < lines.length;) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    if (/^```/.test(line)) {
      const language = line.slice(3).trim(); const content: string[] = []; i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) content.push(lines[i++]!);
      if (i < lines.length) i++;
      blocks.push({ kind: 'code', text: content.join('\n'), language }); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { blocks.push({ kind: 'heading', text: heading[2]! }); i++; continue; }
    if (/^> ?/.test(line)) {
      const content: string[] = [];
      while (i < lines.length && /^> ?/.test(lines[i]!)) content.push(lines[i++]!.replace(/^> ?/, ''));
      blocks.push({ kind: 'quote', text: content.join('\n') }); continue;
    }
    const first = listItem(line);
    if (first) {
      const ordered = !!first[2]; const items: string[] = [];
      while (i < lines.length) {
        const item = listItem(lines[i]!);
        if (!item || !!item[2] !== ordered) break;
        items.push(item[3]!); i++;
      }
      blocks.push({ kind: 'list', ordered, start: Number(first[2] ?? 1), items }); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && !special(lines[i]!)) paragraph.push(lines[i++]!);
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}

export function renderSafeReply(target: HTMLElement, text: string) {
  const doc = target.ownerDocument;
  const fragment = doc.createDocumentFragment();
  const inline = (element: HTMLElement, value: string) => {
    for (const part of replyInline(value)) {
      const child = part.kind === 'text' ? doc.createTextNode(part.text) : doc.createElement(part.kind);
      child.textContent = part.text; element.append(child);
    }
  };
  for (const block of replyBlocks(text)) {
    if (block.kind === 'list') {
      const list = doc.createElement(block.ordered ? 'ol' : 'ul');
      if (list instanceof HTMLOListElement) list.start = block.start;
      for (const item of block.items) { const li = doc.createElement('li'); inline(li, item); list.append(li); }
      fragment.append(list);
    } else if (block.kind === 'code') {
      const pre = doc.createElement('pre'); pre.tabIndex = 0; pre.setAttribute('aria-label', 'Bloque de código');
      const code = doc.createElement('code'); code.textContent = block.text; pre.append(code); fragment.append(pre);
    } else {
      const element = doc.createElement(block.kind === 'heading' ? 'h3' : block.kind === 'quote' ? 'blockquote' : 'p');
      inline(element, block.text); fragment.append(element);
    }
  }
  target.replaceChildren(fragment);
}
