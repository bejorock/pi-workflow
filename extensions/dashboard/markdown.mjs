import { loadRuntimePeer } from './runtime.mjs';
const { Markdown, truncateToWidth, visibleWidth } = await loadRuntimePeer('@earendil-works/pi-tui');
const { highlightCode, initTheme } = await loadRuntimePeer('@earendil-works/pi-coding-agent');

export const palette = { bg: [13,16,26], text: [215,226,240], muted: [112,135,158],
  cyan: [80,220,240], purple: [178,143,255], green: [95,205,140], amber: [232,182,82], border: [44,61,82] };
export const fg = (rgb, text) => `\x1b[38;2;${rgb.join(';')}m${text}\x1b[39m`;
export const color = (key, text) => fg(palette[key] ?? palette.text, text);
// Files and model output are untrusted terminal input. Never preserve embedded
// escape sequences or C0/C1 control characters from source Markdown/labels.
export const safeText = value => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
export const stripFrontmatter = text => text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
let initialized = false;
export function markdownTheme() {
  if (!initialized) { initTheme('dark'); initialized = true; }
  return {
    heading: t => `\x1b[1m${color('cyan', t)}\x1b[22m`, link: t => color('cyan',t), linkUrl: t => color('muted',t),
    code: t => color('amber',t), codeBlock: t => color('text',t), codeBlockBorder: t => color('border',t),
    quote: t => color('muted',t), quoteBorder: t => color('purple',t), hr: t => color('border',t),
    listBullet: t => color('purple',t), bold: t => `\x1b[1m${t}\x1b[22m`, italic: t => `\x1b[3m${t}\x1b[23m`,
    strikethrough: t => `\x1b[9m${t}\x1b[29m`, underline: t => `\x1b[4m${t}\x1b[24m`, highlightCode,
  };
}
export function renderMarkdown(source, width) {
  const text = safeText(stripFrontmatter(String(source ?? '')));
  return new Markdown(text, 0, 0, markdownTheme(), {color: t => color('text',t)}).render(Math.max(8,width));
}
export function fit(text, width) {
  const clipped = truncateToWidth(text, Math.max(0,width));
  return clipped + ' '.repeat(Math.max(0,width-visibleWidth(clipped)));
}
export { visibleWidth };
