// The editing DOM belongs to the browser, especially during IME composition.
// Only populate it before editing; never normalize it during an input event.
export function setEditorText(editor, text) {
  editor.textContent = text;
  // A terminal newline needs a final empty line box. Native plaintext editing
  // likewise keeps one extra trailing newline/BR as a caret placeholder.
  if (text.endsWith("\n")) editor.append(document.createElement("br"));
  editor.dataset.empty = String(text.length === 0);
}

export function readEditorText(editor) {
  // Native plaintext insertion may use newline characters, BRs, or DIV lines.
  // Chromium's innerText double-counts some BR + empty DIV combinations. Read
  // their line boundaries directly, without layout or rewriting the live DOM.
  let text = "";
  const boundary = () => { if (text && !text.endsWith("\n")) text += "\n"; };
  const visit = parent => {
    let previousBlock = false;
    for (const node of parent.childNodes) {
      const block = node.nodeName === "DIV" || node.nodeName === "P";
      if (block || previousBlock) boundary();
      if (node.nodeType === Node.TEXT_NODE) text += node.data;
      else if (node.nodeName === "BR") text += "\n";
      else visit(node);
      previousBlock = block;
    }
  };
  visit(editor);
  // Both initial population and native editing include a final caret placeholder
  // when a note ends on an empty line. Authored preceding blank lines stay intact.
  return text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
}

export function mirroredEditorCaret(editor, mirror) {
  const selection = editor.ownerDocument.getSelection();
  const range = editor.ownerDocument.createRange();
  range.selectNodeContents(mirror);
  range.collapse(false);
  if (!selection?.focusNode || !editor.contains(selection.focusNode)) return range;
  // Preserve native paragraph/BR structure and the selection's moving end.
  // Counting text characters would lose block boundaries in pasted paragraphs.
  const path = [];
  for (let node = selection.focusNode; node !== editor; node = node.parentNode) {
    path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes, node));
  }
  let target = mirror;
  for (const index of path) target = target.childNodes[index];
  range.setStart(target, selection.focusOffset);
  if (target.nodeType === Node.ELEMENT_NODE && selection.focusOffset === target.childNodes.length && target.lastChild) {
    // WebKit can report the host's end after Enter, beyond the final caret
    // placeholder. Measure the visible last line, not an invented extra line.
    let last = target.lastChild;
    while (last.lastChild) last = last.lastChild;
    if (last.nodeType === Node.TEXT_NODE) range.setStart(last, last.length - (last.data.endsWith("\n") ? 1 : 0));
    else if (last.nodeName === "BR") range.setStartBefore(last);
  }
  range.collapse(true);
  return range;
}

export function placeEditorCaretAtEnd(editor) {
  // Called after setEditorText, before native editing creates paragraph blocks.
  const text = readEditorText(editor);
  const walker = editor.ownerDocument.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
  let remaining = text.length;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (remaining <= node.length) {
      editor.ownerDocument.getSelection().setPosition(node, remaining);
      return;
    }
    remaining -= node.length;
  }
  editor.ownerDocument.getSelection().setPosition(editor, 0);
}
