#!/usr/bin/env node
/**
 * The words this product does not use.
 *
 * StakeAm is a market for trading a view on a real-world event. That is a claim
 * about mechanics — winners are paid from the pot, there is no house, no edge
 * is built into the price — and the vocabulary has to match it or the claim is
 * decoration. A single "bet" or "your winnings" that slips into a notification
 * six months from now undoes the positioning more effectively than any screen
 * restores it, because it is the word a regulator, an app store reviewer and a
 * sceptical user all read first.
 *
 * The other half is the opposite failure. "Invest", "guaranteed" and "grow your
 * money" are the vocabulary of a financial promotion, and this is a
 * points-mode, pre-licence product where positions routinely go to zero. Those
 * words are banned for the same reason "bet" is: they describe something this
 * is not.
 *
 * Heuristic, deliberately. It reads string literals and JSX text out of
 * comment-stripped source rather than parsing — a real parse would be stricter
 * and slower, and the failure mode that matters is a word reaching a screen,
 * which this catches. Prose in comments is free to say "bet" while explaining
 * why the product does not.
 *
 *   node scripts/check-vocabulary.mjs
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

/**
 * Betting vocabulary. `odds` is here as well as the obvious ones: it is the
 * single word that most reliably makes a price look like a bookmaker's number
 * rather than a market's.
 */
const BETTING =
  /\b(bet|bets|betting|bettor|bettors|betslip|wager|wagers|wagered|wagering|punter|punters|odds|jackpot|stake\s*out|accumulator)\b/i;

/** The vocabulary of a financial promotion, which this is not. */
const PROMOTION = /\b(invest|invests|investing|investment|investments|investor|investors)\b/i;
const GUARANTEE = /\b(guarantee|guaranteed|guarantees|risk[- ]free|sure thing|can'?t lose)\b/i;
const GROWTH = /\bgrow (your|their) money\b|\bmake money fast\b|\bpassive income\b/i;

/**
 * "Returns" as a promise, not as a verb.
 *
 * "How many rows a leaderboard page returns" is a description of code and has
 * nothing to do with money; "your returns" is a claim about what somebody will
 * get. The difference is the article or possessive in front of it, so that is
 * what this matches — and "returns on settlement" is exempt because it names
 * the one thing that genuinely happens.
 */
const RETURNS = /\b(your|their|the|high|big|great|strong|expected|guaranteed)\s+returns\b/i;
const RETURNS_QUALIFIED = /\breturns on settlement\b/i;

/** "Winnings" belongs to a betting shop; the money here is a settled position. */
const WINNINGS = /\bwinnings\b/i;

const RULES = [
  ['betting vocabulary', BETTING],
  ['financial-promotion vocabulary', PROMOTION],
  ['a guarantee this product cannot make', GUARANTEE],
  ['get-rich framing', GROWTH],
  ['"winnings" — say "returns on settlement"', WINNINGS],
];

/**
 * The disclosure, which says what StakeAm is *not*.
 *
 * These are the one place the banned words earn their keep: "a prediction
 * market, not a betting site" and "nothing here is a real-money wager" are the
 * sentences that make the positioning legible to somebody looking for the
 * catch. Deleting them to satisfy a word list would be the check defeating its
 * own purpose, so they are named here rather than quietly matched.
 *
 * Removed from the text before testing rather than used to skip the line. These
 * strings are long — a whole FAQ answer is one line — so skipping the line would
 * exempt every other word in the sentence, and a check that stops checking as
 * soon as it sees an approved phrase is worse than no check: it stays green
 * while a disclosure quietly grows a promise on the end of it. Verified by
 * appending "invest and grow your money with guaranteed returns" to exactly
 * that answer, which the line-skipping version passed without complaint.
 */
const ALLOWED = [
  /not a betting site/i,
  /real-money wager/i,
  /you are not trading against a house/i,
  // The check's own patterns, and the copy that documents them.
  /check-vocabulary/i,
];

/**
 * Files whose whole job is to name the words this product refuses.
 *
 * The moderation module is a blocklist: it exists to catch "guaranteed win" and
 * "sure odds" in a user's comment, and it cannot do that without containing
 * them. Its refusal messages say plainly what is not allowed, which is the same
 * positioning this check enforces rather than a breach of it. Exempting the
 * file is honest; rewording a detector to satisfy a word list would break the
 * detector and change nothing a user sees.
 */
const EXEMPT = [/^apps\/api\/src\/community-layer\/moderation\.ts$/];

/**
 * Where user-facing words live.
 *
 * One entry per extension, with no `{ts,tsx}` braces: `git ls-files` pathspecs
 * do not expand them, so the brace form silently matched **nothing** and the
 * whole web app went unchecked while the script reported "clean". Caught by
 * appending a paragraph of banned words to an FAQ answer and watching it pass.
 */
const GLOBS = [
  'apps/web/src/**/*.ts',
  'apps/web/src/**/*.tsx',
  'apps/web/messages/*.json',
  'apps/api/src/**/*.ts',
];

function sources() {
  const out = execSync(`git ls-files ${GLOBS.map((glob) => `'${glob}'`).join(' ')}`, {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .filter((line) => line !== '' && !/\.(test|spec)\.tsx?$/.test(line))
    .filter((line) => !EXEMPT.some((pattern) => pattern.test(line)));
}

/**
 * Strip comments so prose *about* the rule does not trip it.
 *
 * Order matters: block comments first, then line comments, and neither inside a
 * string. Getting that last part exactly right needs a lexer; the cost of
 * getting it slightly wrong here is a false positive on a line containing `//`
 * inside a URL, which is why URLs are dropped first.
 */
function strip(source) {
  return source
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

/** String literals and JSX text — the two ways a word reaches a screen. */
function userFacing(source) {
  const found = [];
  const strings = source.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g);
  for (const match of strings) found.push(match[2]);
  const jsx = source.matchAll(/>([^<>{}]{3,})</g);
  for (const match of jsx) found.push(match[1]);
  return found;
}

let failures = 0;
for (const file of sources()) {
  const source = strip(readFileSync(file, 'utf8'));
  const lines = source.split('\n');

  for (const [index, line] of lines.entries()) {
    for (const raw of userFacing(line)) {
      const text = ALLOWED.reduce((rest, allowed) => rest.replace(allowed, ' '), raw);
      for (const [why, pattern] of RULES) {
        const hit = pattern.exec(text);
        if (hit === null) continue;
        console.error(`${file}:${index + 1}  ${why}: “${hit[0]}”`);
        console.error(`    ${text.trim().slice(0, 100)}`);
        failures += 1;
      }
      if (RETURNS.test(text) && !RETURNS_QUALIFIED.test(text)) {
        console.error(`${file}:${index + 1}  unqualified “returns” — say “returns on settlement”`);
        console.error(`    ${text.trim().slice(0, 100)}`);
        failures += 1;
      }
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} banned term${failures === 1 ? '' : 's'} in user-facing strings.`);
  console.error('See the note at the top of scripts/check-vocabulary.mjs for why each is banned.');
  process.exit(1);
}
console.log('vocabulary: clean');
