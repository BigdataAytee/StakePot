import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { FUNNEL, type EventName, type EventProperties } from './events';

/**
 * Writing and reading §3's `events` table.
 *
 * Every write is typed by `EVENT_SCHEMAS`, and every write is best-effort:
 * analytics must never be the reason a trade fails. That is not carelessness
 * about data quality — it is the correct ordering of concerns, and it is why
 * the money paths keep their own records in the ledger rather than trusting
 * this table for anything that has to be true.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async record<N extends EventName>(
    name: N,
    properties: EventProperties<N>,
    userId?: string,
  ): Promise<void> {
    try {
      await this.prisma.event.create({
        data: {
          ...(userId === undefined ? {} : { userId }),
          name,
          propertiesJson: properties as Prisma.InputJsonValue,
        },
      });
    } catch {
      // Deliberately swallowed. A failed analytics write is not a failed trade.
    }
  }

  /** Counts per event over a window — the spine of §6.8's dashboard. */
  async counts(since: Date, until = new Date()) {
    const rows = await this.prisma.event.groupBy({
      by: ['name'],
      where: { ts: { gte: since, lt: until } },
      _count: { _all: true },
    });

    return rows
      .map((row) => ({ name: row.name, count: row._count._all }))
      .sort((left, right) => right.count - left.count);
  }

  /**
   * The funnel, as distinct people rather than event counts.
   *
   * Counting events would flatter every stage: one person viewing forty markets
   * is not forty people considering a stake. Anonymous rows are excluded — they
   * cannot be followed to the next step, so counting them would inflate the top
   * of the funnel and make the drop-off look worse than it is.
   */
  async funnel(since: Date, until = new Date()) {
    const stages = await Promise.all(
      FUNNEL.map(async (name) => {
        const rows = await this.prisma.event.findMany({
          where: { name, ts: { gte: since, lt: until }, userId: { not: null } },
          distinct: ['userId'],
          select: { userId: true },
        });
        return { stage: name, people: rows.length };
      }),
    );

    const top = stages[0]?.people ?? 0;
    return stages.map((stage) => ({
      ...stage,
      shareOfTop: top === 0 ? null : stage.people / top,
    }));
  }

  /** A day-by-day series for one event, for the dashboard's sparklines. */
  async daily(name: EventName, days = 14, until = new Date()) {
    const since = new Date(until.getTime() - days * 86_400_000);
    const rows = await this.prisma.event.findMany({
      where: { name, ts: { gte: since, lt: until } },
      select: { ts: true },
      take: 50_000,
    });

    const buckets = new Map<string, number>();
    for (let index = 0; index < days; index += 1) {
      const day = new Date(since.getTime() + index * 86_400_000);
      buckets.set(day.toISOString().slice(0, 10), 0);
    }
    for (const row of rows) {
      const key = row.ts.toISOString().slice(0, 10);
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    return [...buckets.entries()].map(([day, count]) => ({ day, count }));
  }
}
