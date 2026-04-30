const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMdV2(text: string): string {
  return text.replace(MDV2_SPECIAL, (m) => `\\${m}`);
}

export function code(text: string): string {
  return "`" + text.replace(/`/g, "\\`").replace(/\\/g, "\\\\") + "`";
}

export function codeBlock(text: string, lang = ""): string {
  const safe = text.replace(/```/g, "ʼʼʼ");
  return "```" + lang + "\n" + safe + "\n```";
}

export function bold(text: string): string {
  return "*" + escapeMdV2(text) + "*";
}

export function italic(text: string): string {
  return "_" + escapeMdV2(text) + "_";
}
