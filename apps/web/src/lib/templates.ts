/**
 * The ticket-template library (§2.14a).
 *
 * A blank form is the reason most people never create a market: they do not
 * know what a settleable question looks like. Each template is a worked
 * example with the source already named — the part creators get wrong most
 * often, and the part the Rulebook's golden rule turns on.
 */
export interface TicketTemplate {
  id: string;
  category: 'football' | 'economic' | 'election' | 'bbnaija' | 'awards' | 'transfer';
  name: string;
  question: string;
  outcomes: { label: string; criteria: string }[];
  otherLabel?: string;
  sourceName: string;
  sourceUrl: string;
}

export const TICKET_TEMPLATES: TicketTemplate[] = [
  {
    id: 'match-result',
    category: 'football',
    name: 'Match result',
    question: 'Will [team] beat [opponent] on [day]?',
    outcomes: [
      { label: 'YES', criteria: '[team] wins in regulation or extra time.' },
      { label: 'NO', criteria: 'Draw, loss, or the match is decided on penalties.' },
    ],
    sourceName: 'CAF official match report',
    sourceUrl: 'https://www.cafonline.com/',
  },
  {
    id: 'fx-threshold',
    category: 'economic',
    name: 'Naira threshold',
    question: 'Will the naira close under ₦[rate]/$ on [date]?',
    outcomes: [
      { label: 'YES', criteria: 'The CBN closing rate is below ₦[rate] to the dollar.' },
      { label: 'NO', criteria: 'The rate is ₦[rate] or above.' },
    ],
    sourceName: 'CBN official rate',
    sourceUrl: 'https://www.cbn.gov.ng/rates/',
  },
  {
    id: 'who-wins',
    category: 'election',
    name: 'Who wins',
    question: 'Who wins the [race]?',
    outcomes: [
      { label: '[Candidate A]', criteria: 'Declared winner by INEC.' },
      { label: '[Candidate B]', criteria: 'Declared winner by INEC.' },
    ],
    otherLabel: 'Any other',
    sourceName: 'INEC declared result',
    sourceUrl: 'https://inecnigeria.org/',
  },
  {
    id: 'eviction',
    category: 'bbnaija',
    name: 'Eviction night',
    question: 'Will [housemate] be evicted on [date]?',
    outcomes: [
      { label: 'YES', criteria: '[housemate] is announced as evicted in that live show.' },
      { label: 'NO', criteria: 'They are not evicted in that show.' },
    ],
    sourceName: 'Africa Magic live show',
    sourceUrl: 'https://africamagic.dstv.com/',
  },
];
