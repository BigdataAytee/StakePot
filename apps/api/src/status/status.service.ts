import { Injectable } from '@nestjs/common';
import type { IncidentSeverity, IncidentState } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

export class StatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatusError';
  }
}

/**
 * The public status page (§2.12).
 *
 * "Public uptime/incident page fed by the monitoring stack; incidents posted
 * with timestamps — transparency as a feature."
 *
 * An incident is a title plus a timeline of updates, each carrying the state it
 * moved to. Nothing is ever edited: a status page that rewrites its own history
 * is worth less than no status page, so a correction is another update.
 */
@Injectable()
export class StatusService {
  constructor(private readonly prisma: PrismaService) {}

  /** What the public page shows: live incidents first, then recent history. */
  async page(now = new Date()) {
    const [open, recent, reconciliation] = await Promise.all([
      this.prisma.statusIncident.findMany({
        where: { state: { not: 'resolved' } },
        include: { updates: { orderBy: { createdAt: 'desc' } } },
        orderBy: { startedAt: 'desc' },
      }),
      this.prisma.statusIncident.findMany({
        where: { state: 'resolved', startedAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
        include: { updates: { orderBy: { createdAt: 'desc' } } },
        orderBy: { startedAt: 'desc' },
        take: 20,
      }),
      this.prisma.reconciliationRun.findFirst({ orderBy: { runDate: 'desc' } }),
    ]);

    const worst = open.reduce<IncidentSeverity | null>((acc, incident) => {
      if (acc === 'outage') return acc;
      if (incident.severity === 'outage') return 'outage';
      if (incident.severity === 'degraded') return 'degraded';
      return acc ?? incident.severity;
    }, null);

    return {
      /** One word, because that is what somebody checking a status page wants. */
      status: worst === null ? 'operational' : worst,
      checkedAt: now.toISOString(),
      // The money check is public on purpose: §2.10's daily reconciliation is
      // the platform's own audit, and hiding its result would be the opposite of
      // "transparency as a feature".
      reconciliation: {
        status: reconciliation?.status ?? 'never-run',
        runDate: reconciliation?.runDate.toISOString() ?? null,
      },
      incidents: [...open, ...recent].map((incident) => ({
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        state: incident.state,
        startedAt: incident.startedAt.toISOString(),
        resolvedAt: incident.resolvedAt?.toISOString() ?? null,
        updates: incident.updates.map((update) => ({
          id: update.id,
          state: update.state,
          body: update.body,
          createdAt: update.createdAt.toISOString(),
        })),
      })),
    };
  }

  async open(params: {
    title: string;
    severity: IncidentSeverity;
    body: string;
    postedBy: string;
  }) {
    if (params.title.trim().length < 5) throw new StatusError('an incident needs a title');
    if (params.body.trim().length < 10) {
      throw new StatusError('say what is happening — this is the public record');
    }

    return this.prisma.statusIncident.create({
      data: {
        title: params.title.trim(),
        severity: params.severity,
        postedBy: params.postedBy,
        updates: {
          create: { state: 'investigating', body: params.body.trim(), postedBy: params.postedBy },
        },
      },
      include: { updates: true },
    });
  }

  /** Post an update. Moving to `resolved` closes the incident and stamps it. */
  async update(params: {
    incidentId: string;
    state: IncidentState;
    body: string;
    postedBy: string;
    now?: Date;
  }) {
    const now = params.now ?? new Date();
    const incident = await this.prisma.statusIncident.findUnique({
      where: { id: params.incidentId },
    });
    if (incident === null) throw new StatusError('no such incident');
    if (params.body.trim().length < 10) throw new StatusError('say what changed');

    await this.prisma.incidentUpdate.create({
      data: {
        incidentId: incident.id,
        state: params.state,
        body: params.body.trim(),
        postedBy: params.postedBy,
      },
    });

    return this.prisma.statusIncident.update({
      where: { id: incident.id },
      data: {
        state: params.state,
        ...(params.state === 'resolved' ? { resolvedAt: now } : {}),
      },
      include: { updates: { orderBy: { createdAt: 'desc' } } },
    });
  }
}
