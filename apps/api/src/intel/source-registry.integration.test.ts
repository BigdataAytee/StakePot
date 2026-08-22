import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AdminAuditService } from '../audit/admin-audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import { resetDatabase } from '../testing/reset';
import { SourceRegistryError, SourceRegistryService } from './source-registry.service';

/**
 * The registry, and the one sentence it exists to make true: nothing but a
 * tier-1 source can settle a market.
 */
const TEST_DATABASE_URL = process.env['TEST_DATABASE_URL'];

describe.skipIf(!TEST_DATABASE_URL)('source registry (integration)', () => {
  let prisma: PrismaService;
  let registry: SourceRegistryService;
  const staffId = 'staff-1';

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL as string } },
    }) as unknown as PrismaService;
    await prisma.$connect();
    registry = new SourceRegistryService(prisma, new AdminAuditService(prisma));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.user.create({
      data: { id: staffId, email: 'sources@example.ng', pwHash: 'x', role: 'admin' },
    });
  });

  const cbn = {
    tier: 'resolution' as const,
    kind: 'api' as const,
    name: 'CBN',
    homeUrl: 'https://www.cbn.gov.ng/',
    feedUrl: 'https://www.cbn.gov.ng/rates/exchratebycurrency.asp',
    categories: ['economy'],
  };
  const paper = {
    tier: 'news' as const,
    kind: 'rss' as const,
    name: 'A newspaper',
    homeUrl: 'https://example-paper.ng',
    categories: ['economy'],
  };

  it('imports in bulk and is safe to re-import', async () => {
    const first = await registry.importSources({ sources: [cbn, paper], staffId, ip: '10.0.0.1' });
    expect(first).toEqual({ added: 2, updated: 0 });

    const second = await registry.importSources({ sources: [cbn, paper], staffId, ip: '10.0.0.1' });
    expect(second).toEqual({ added: 0, updated: 2 });
    expect(await prisma.source.count()).toBe(2);
  });

  it('starts a source at its tier’s trust rather than at zero', async () => {
    // A source starting at zero would be demoted before it had done anything.
    await registry.importSources({ sources: [cbn, paper], staffId, ip: '10.0.0.1' });
    const rows = await prisma.source.findMany({ orderBy: { name: 'asc' } });
    expect(Number(rows[0]?.trust)).toBeCloseTo(0.6, 3);
    expect(Number(rows[1]?.trust)).toBeCloseTo(1, 3);
  });

  it('refuses anything that is not https', async () => {
    await expect(
      registry.importSources({
        sources: [{ ...paper, homeUrl: 'http://example-paper.ng' }],
        staffId,
        ip: '10.0.0.1',
      }),
    ).rejects.toBeInstanceOf(SourceRegistryError);
  });

  it('lets only tier 1 settle a market', async () => {
    await registry.importSources({ sources: [cbn, paper], staffId, ip: '10.0.0.1' });

    expect(await registry.maySettleAgainst('https://www.cbn.gov.ng/rates/')).toBe(true);
    expect(await registry.maySettleAgainst('https://example-paper.ng/story/1')).toBe(false);
    expect(await registry.maySettleAgainst('https://somewhere-else.ng/')).toBe(false);
  });

  it('will not settle against a source somebody has switched off', async () => {
    await registry.importSources({ sources: [cbn], staffId, ip: '10.0.0.1' });
    await registry.setEnabled({
      scope: { tier: 'resolution' },
      enabled: false,
      reason: 'the feed is returning last month’s rates',
      staffId,
      ip: '10.0.0.1',
    });

    expect(await registry.maySettleAgainst('https://www.cbn.gov.ng/rates/')).toBe(false);
  });

  it('insists on a reason before switching anything off', async () => {
    await registry.importSources({ sources: [cbn], staffId, ip: '10.0.0.1' });
    await expect(
      registry.setEnabled({ scope: 'all', enabled: false, reason: 'x', staffId, ip: '10.0.0.1' }),
    ).rejects.toThrow(/say why/);
  });

  it('demotes a news source that keeps contradicting tier 1', async () => {
    await registry.importSources({ sources: [paper], staffId, ip: '10.0.0.1' });
    const id = (await prisma.source.findFirstOrThrow({ where: { name: paper.name } })).id;

    await registry.recordConflict(id);
    await registry.recordConflict(id);
    expect((await prisma.source.findUniqueOrThrow({ where: { id } })).enabled).toBe(true);

    await registry.recordConflict(id);
    const demoted = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(demoted.enabled).toBe(false);
    expect(demoted.disabledBy).toBe('system');
    expect(demoted.disabledReason).toMatch(/Contradicted a resolution source/);
  });

  it('does not demote a resolution source behind anybody’s back', async () => {
    // A body whose publication *is* the fact contradicting itself is an
    // incident for a person to look at, not a score to decay quietly — and
    // switching it off automatically would strand every market naming it.
    await registry.importSources({ sources: [cbn], staffId, ip: '10.0.0.1' });
    const id = (await prisma.source.findFirstOrThrow({ where: { name: 'CBN' } })).id;

    for (let index = 0; index < 6; index += 1) await registry.recordConflict(id);

    const source = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(source.enabled).toBe(true);
    expect(Number(source.trust)).toBe(1);
    expect(source.conflicts).toBe(6);
  });

  it('lets a demoted source be brought back by hand', async () => {
    await registry.importSources({ sources: [paper], staffId, ip: '10.0.0.1' });
    const id = (await prisma.source.findFirstOrThrow({ where: { name: paper.name } })).id;
    for (let index = 0; index < 3; index += 1) await registry.recordConflict(id);

    await registry.setEnabled({
      scope: { sourceId: id },
      enabled: true,
      reason: 'checked — the conflicts were our parser, not them',
      staffId,
      ip: '10.0.0.1',
    });

    const back = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(back.enabled).toBe(true);
    expect(back.disabledReason).toBeNull();
  });

  it('keeps a source’s record through a re-import', async () => {
    // Otherwise the fix for a demoted source is to import the list again,
    // which is not a fix.
    await registry.importSources({ sources: [paper], staffId, ip: '10.0.0.1' });
    const id = (await prisma.source.findFirstOrThrow({ where: { name: paper.name } })).id;
    await registry.recordConflict(id);

    await registry.importSources({ sources: [paper], staffId, ip: '10.0.0.1' });
    const after = await prisma.source.findUniqueOrThrow({ where: { id } });
    expect(after.conflicts).toBe(1);
    expect(Number(after.trust)).toBeCloseTo(0.45, 3);
  });
});
