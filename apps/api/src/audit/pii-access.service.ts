import { Injectable } from '@nestjs/common';

import { logger } from '../logger';
import { PrismaService } from '../prisma/prisma.service';

/**
 * §2.11's "field-level access logging".
 *
 * Separate from `admin_audit`, which records mutations. A support agent
 * reading somebody's phone number changes nothing, and it is exactly the
 * access that needs a trail: the insider abuse this catches is looking, not
 * editing. An audit log that only records writes cannot tell you who looked up
 * a public figure's account the day before it appeared in a newspaper.
 *
 * The table has `REVOKE UPDATE, DELETE`, like `ledger`. A log staff can edit
 * is not a log.
 */
@Injectable()
export class PiiAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a reveal.
   *
   * Failure to write the log fails the read. That is the deliberate ordering:
   * if the trail cannot be written, the access does not happen. Logging
   * best-effort after the fact would make the log optional exactly when
   * something is wrong with the database, which is when it matters most.
   */
  async record(entry: {
    staffId: string;
    subjectId: string;
    fields: string[];
    reason: string;
    ip: string;
  }): Promise<void> {
    await this.prisma.piiAccessLog.create({
      data: {
        staffId: entry.staffId,
        subjectId: entry.subjectId,
        fields: entry.fields,
        reason: entry.reason,
        ip: entry.ip,
      },
    });

    logger.info(
      { staffId: entry.staffId, subjectId: entry.subjectId, fields: entry.fields },
      'pii revealed to staff',
    );
  }

  /** What a subject can be told about who looked at them. */
  async forSubject(subjectId: string, take = 50) {
    return this.prisma.piiAccessLog.findMany({
      where: { subjectId },
      orderBy: { createdAt: 'desc' },
      take,
    });
  }

  /** What one member of staff has been looking at — the review a lead does. */
  async byStaff(staffId: string, since: Date) {
    return this.prisma.piiAccessLog.findMany({
      where: { staffId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
    });
  }
}
