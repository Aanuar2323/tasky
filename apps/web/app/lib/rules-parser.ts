export interface RuleItem {
  name: string;
  desc: string;
  tags: string[];
  enabled: boolean;
}

export function parseRulesMarkdown(markdown: string): RuleItem[] {
  if (!markdown) return [];
  const lines = markdown.split("\n");
  const rules: RuleItem[] = [];
  let current: RuleItem | null = null;

  for (const line of lines) {
    const heading = line.match(/^###\s+(.+)/);
    const listDesc = line.match(/^-\s+(.+)/);
    const tagLine = line.match(/^`([^`]+)`$/);

    if (heading) {
      if (current) rules.push(current);
      current = { name: heading[1].trim(), desc: "", tags: [], enabled: true };
      continue;
    }

    if (!current) continue;
    if (listDesc) {
      current.desc = listDesc[1].trim();
      continue;
    }
    if (tagLine) {
      current.tags.push(tagLine[1].trim());
    }
  }

  if (current) rules.push(current);
  return rules;
}

export function rulesToMarkdown(rules: RuleItem[]): string {
  if (!rules.length) return "";
  return rules
    .map((rule) => {
      const title = `### ${rule.name}`;
      const desc = rule.desc ? `- ${rule.desc}` : "- Sin descripcion";
      const tags = rule.tags.map((tag) => `\`${tag}\``).join("\n");
      const status = rule.enabled ? "`enabled`" : "`disabled`";
      return [title, desc, tags, status].filter(Boolean).join("\n");
    })
    .join("\n\n");
}
