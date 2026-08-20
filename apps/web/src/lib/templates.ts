import { API_URL } from '@/lib/api';

/**
 * The ticket-template library (§2.14a).
 *
 * A blank form is the reason most people never create a market: they do not
 * know what a settleable question looks like. Each template is a worked example
 * with the source already named — the part creators get wrong most often, and
 * the part the Rulebook's golden rule turns on.
 *
 * Fetched rather than bundled. Checklist Part 4 makes "you started from a
 * template" something the server verifies, and a list only the client held
 * could not be checked against — a submission could name any template id it
 * liked and the rule would be decoration. So the server owns the library and
 * this reads it, which also means the page can never offer a template a
 * submission would then be refused for citing.
 */
export interface TicketTemplate {
  id: string;
  category: 'football' | 'economic' | 'election' | 'bbnaija' | 'awards' | 'transfer' | 'other';
  name: string;
  question: string;
  outcomes: { label: string; criteria: string }[];
  otherLabel?: string;
  sourceName: string;
  sourceUrl: string;
}

export async function fetchTemplates(): Promise<TicketTemplate[]> {
  const response = await fetch(`${API_URL}/community/templates`);
  if (!response.ok) throw new Error(`Could not load the templates (${response.status})`);
  return (await response.json()) as TicketTemplate[];
}
