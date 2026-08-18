import { describe, expect, it } from 'vitest';

import { explain, flagsFor, verdictFor } from './moderation';

const kinds = (text: string) => flagsFor(text).map((flag) => flag.kind);

describe('comment moderation', () => {
  it('leaves ordinary argument alone', () => {
    const takes = [
      'Petrol will not touch 1200, NNPC just restocked.',
      'I am on NO here. The last three months barely moved.',
      'DM me when it resolves, I want to see your face',
      'This market is a scam abeg',
    ];
    for (const take of takes) {
      expect(flagsFor(take), take).toEqual([]);
      expect(verdictFor(flagsFor(take))).toBe('publish');
    }
  });

  it('catches an external betting link', () => {
    expect(kinds('better odds on bet9ja.com for this one')).toContain('external_betting');
    expect(kinds('https://www.sportybet.com/ng/sport')).toContain('external_betting');
    expect(verdictFor(flagsFor('go to 1xbet instead'))).toBe('hold');
  });

  it('catches tips for sale', () => {
    expect(kinds('VIP odds subscription available')).toContain('tips_for_sale');
    expect(kinds('booking code 5XY2A')).toContain('tips_for_sale');
    expect(kinds('pay 5000 to get my picks')).toContain('tips_for_sale');
  });

  it('catches the sure-odds promise §2.15e names', () => {
    expect(kinds('DM me for sure odds')).toContain('guaranteed_odds');
    expect(kinds('100% guaranteed win today')).toContain('guaranteed_odds');
    expect(kinds('no loss, trust me')).toContain('guaranteed_odds');
  });

  it('treats "DM me" as harvesting only alongside a pitch', () => {
    // Ordinary speech.
    expect(kinds('dm me your thoughts')).not.toContain('contact_harvesting');
    // The handover §2.15e is actually about.
    expect(kinds('DM me for sure odds')).toContain('contact_harvesting');
  });

  it('catches a bare phone number on its own', () => {
    expect(kinds('reach me 08031234567')).toContain('contact_harvesting');
    expect(kinds('reach me +234 803 123 4567')).toContain('contact_harvesting');
  });

  it('applies the same banned topics markets follow', () => {
    expect(kinds('I hope the man dies before it settles')).toContain('banned_topic');
    expect(verdictFor(flagsFor('I hope the man dies before it settles'))).toBe('flag');
  });

  it('holds a hard ban and only flags a soft one', () => {
    // Hard bans stay out of the thread until a person looks.
    expect(verdictFor(flagsFor('sure odds, whatsapp me'))).toBe('hold');
    // A banned topic is published-but-queued: it may well be ordinary speech.
    expect(verdictFor(flagsFor('this market will kill my weekend'))).toBe('flag');
  });

  it('shows the reviewer what actually matched', () => {
    const flags = flagsFor('best odds on betking.com, DM me for sure odds');
    expect(flags.every((flag) => flag.evidence.length > 0)).toBe(true);
    expect(new Set(flags.map((flag) => `${flag.kind}:${flag.evidence}`)).size).toBe(flags.length);
  });

  it('tells the commenter something arguable, not a mystery', () => {
    expect(explain(flagsFor('go to 1xbet'))).toContain('betting sites');
    expect(explain(flagsFor('booking code 5XY2A'))).toContain('Selling tips');
    expect(explain([])).toBe('');
  });
});
