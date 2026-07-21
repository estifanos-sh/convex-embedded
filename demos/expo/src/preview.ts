const previewLength = 280;

export function documentPreview(body: string): string {
  try {
    const value = JSON.parse(body) as unknown;
    if (!Array.isArray(value)) return "";
    return value.slice(1).map(nodeText).filter(Boolean).join("\n").trim().slice(0, previewLength);
  } catch {
    return "";
  }
}

function nodeText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(nodeText).join("");
  if (!value || typeof value !== "object") return "";

  const node = value as { children?: unknown; content?: unknown; text?: unknown };
  if (typeof node.text === "string") return node.text;
  return [node.content, node.children].map(nodeText).filter(Boolean).join("\n");
}
