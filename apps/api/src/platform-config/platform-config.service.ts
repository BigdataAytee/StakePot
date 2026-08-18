import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CONFIG_SCHEMAS, type ConfigKey, type ConfigValue } from './config-keys';

/**
 * Reads the active value of a config key (§6.4b).
 *
 * "Every tunable value in this document lives here as an editable setting —
 * never in code." Nothing in the application may hardcode a fee, a limit or a
 * threshold; it asks for it here.
 *
 * Values are cached in memory and refreshed on a short interval rather than
 * read per call — an effective-date change lands within one refresh, which is
 * well inside the 24h activation delay §6.4b mandates.
 */
@Injectable()
export class PlatformConfigService implements OnModuleInit {
  private cache = new Map<string, unknown>();
  private loadedAt = 0;

  /** How long a cached value may be served before it is re-read. */
  private static readonly TTL_MS = 30_000;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const rows = await this.prisma.platformConfig.findMany({ where: { state: 'active' } });
    const next = new Map<string, unknown>();
    for (const row of rows) {
      next.set(row.key, row.valueJson);
    }
    this.cache = next;
    this.loadedAt = Date.now();
  }

  /**
   * Read a key. Throws if it is missing or malformed — a money path must never
   * quietly fall back to a default the operator never approved.
   */
  async get<K extends ConfigKey>(key: K): Promise<ConfigValue<K>> {
    if (Date.now() - this.loadedAt > PlatformConfigService.TTL_MS) {
      await this.refresh();
    }

    if (!this.cache.has(key)) {
      throw new Error(
        `platform_config is missing an active row for "${key}" — seed it before anything reads it`,
      );
    }

    const parsed = CONFIG_SCHEMAS[key].safeParse(this.cache.get(key));
    if (!parsed.success) {
      throw new Error(`platform_config value for "${key}" is malformed: ${parsed.error.message}`);
    }
    return parsed.data as ConfigValue<K>;
  }
}
