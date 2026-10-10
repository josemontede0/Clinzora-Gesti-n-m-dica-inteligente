import { Injectable } from '@nestjs/common';
import { DEFAULT_OPERATIONAL_SETTINGS, OperationalSettings, operationalSettingsSchema } from '@medigest/shared';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const OPERATIONAL_KEY = 'operational';

@Injectable()
export class SettingsService {
  private cache = new Map<string, { value: OperationalSettings; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async operational(organizationId: string): Promise<OperationalSettings> {
    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < 30_000) return hit.value;
    const row = await this.prisma.systemSetting.findUnique({ where: { organizationId_key: { organizationId, key: OPERATIONAL_KEY } } });
    const merged = { ...DEFAULT_OPERATIONAL_SETTINGS, ...((row?.value as object) ?? {}) };
    const parsed = operationalSettingsSchema.safeParse(merged);
    const value = parsed.success ? parsed.data : DEFAULT_OPERATIONAL_SETTINGS;
    this.cache.set(organizationId, { value, at: Date.now() });
    return value;
  }

  async saveOperational(organizationId: string, value: OperationalSettings, userId: string) {
    await this.prisma.systemSetting.upsert({
      where: { organizationId_key: { organizationId, key: OPERATIONAL_KEY } },
      create: { organizationId, key: OPERATIONAL_KEY, value: value as unknown as Prisma.InputJsonValue, updatedById: userId },
      update: { value: value as unknown as Prisma.InputJsonValue, updatedById: userId },
    });
    this.cache.delete(organizationId);
    return value;
  }

  async timezone(organizationId: string): Promise<string> {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } });
    return org?.timezone ?? 'America/Santo_Domingo';
  }
}
