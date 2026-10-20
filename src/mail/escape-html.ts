const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** For any value that reaches an email's HTML: names, addresses, product names, links. */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ENTITIES[char]);
