/**
 * Hand text to the DSH conversation composer.
 * 1) Insert into the focused/first composer editor (Lexical contenteditable) via a synthetic paste,
 *    which DSH's editor accepts as user input (so the draft store sees it).
 * 2) Fallback: copy to clipboard so the user can paste.
 * Returns 'inserted' | 'copied'.
 */
export async function sendToChat(text) {
  // rimlist_* tools are hidden until "/rimlist" appears in the session — prefix it so panel prompts work.
  if (!/(^|\s)\/rimlist(?=\s|$)/.test(text)) text = '/rimlist ' + text
  const editor = findComposer()
  if (editor) {
    try {
      editor.focus()
      const sel = window.getSelection()
      if (sel) {
        const range = document.createRange()
        range.selectNodeContents(editor)
        range.collapse(false)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      const dt = new DataTransfer()
      dt.setData('text/plain', text)
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      editor.dispatchEvent(ev)
      if (editor.textContent && editor.textContent.includes(text.slice(0, 40))) return 'inserted'
      // some editors ignore synthetic paste: try insertText
      if (document.execCommand && document.execCommand('insertText', false, text)) return 'inserted'
    } catch {}
  }
  try {
    await navigator.clipboard.writeText(text)
  } catch {}
  return 'copied'
}

function findComposer() {
  const seat = document.querySelector('[data-composer-seat]') || document.querySelector('[data-conversation-region="composer"]') || document
  return seat.querySelector('[contenteditable="true"][data-lexical-editor="true"]') || seat.querySelector('[contenteditable="true"]')
}
