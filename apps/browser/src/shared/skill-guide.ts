// The guide `agb skill` prints (docs/SPEC.md §13.4). The template lives in packages/skill/guide.md;
// the agb CLI embeds the same file as a fallback for when the browser isn't running.
import template from "../../../../packages/skill/guide.md";

/** The last line of the guide. Agents check for it to know the output wasn't cut off. */
export const GUIDE_END = "[agb:skill] end of guide";

export interface GuideVars {
  appVersion: string;
  protocol: string;
}

/** Fills in {{appVersion}} and {{protocol}}. Must match apps/cli/internal/skill (Render). */
export function renderGuide(vars: GuideVars, text: string = template): string {
  const out = text.replace(/\r\n/g, "\n").replace(/\{\{(appVersion|protocol)\}\}/g, (_, k: keyof GuideVars) => vars[k]);
  return out.endsWith("\n") ? out : `${out}\n`;
}
