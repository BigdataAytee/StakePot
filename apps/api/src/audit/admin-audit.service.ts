import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../ledger/ledger.service';

export interface AdminAuditEntry {
  readonly staffId: string;
  readonly action: string;
  readonly targetRef: string;
  readonly before?: Prisma.InputJsonValue;
  readonly after?: Prisma.InputJsonValue;
  readonly ip: string;
}

/**
 * §2.11: "Every admin action writes to an immutable `admin_audit` table (who,
 * what, before/after, IP, timestamp)."
 *
 * Append-only at the database level, same as the ledger — there is no update or
 * delete method here because there is no grant behind one.
 */
@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AdminAuditEntry, tx?: Tx): Promise<void> {
    const client = tx ?? this.prisma;
    await client.adminAudit.create({
      data: {
        staffId: entry.staffId,
        action: entry.action,
        targetRef: entry.targetRef,
        ...(entry.before === undefined ? {} : { beforeJson: entry.before }),
        ...(entry.after === undefined ? {} : { afterJson: entry.after }),
        ip: entry.ip,
      },
    });
  }
}
