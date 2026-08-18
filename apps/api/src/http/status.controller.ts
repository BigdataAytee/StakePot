import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { IncidentSeverity, IncidentState } from '@prisma/client';
import { IsIn, IsString, MinLength } from 'class-validator';

import { JwtGuard, type RequestWithUser } from '../auth/jwt.guard';
import { Roles, RolesGuard } from '../auth/roles.guard';
import { StatusError, StatusService } from '../status/status.service';

export class OpenIncidentDto {
  @IsString() @MinLength(5) title!: string;
  @IsIn(['informational', 'degraded', 'outage']) severity!: IncidentSeverity;
  @IsString() @MinLength(10) body!: string;
}

export class IncidentUpdateDto {
  @IsIn(['investigating', 'identified', 'monitoring', 'resolved']) state!: IncidentState;
  @IsString() @MinLength(10) body!: string;
}

/**
 * The status page (§2.12) — public by design, posted from the admin system room
 * (§6.9). "Transparency as a feature" only works if the page is readable
 * without a login, including when the platform is the thing that is broken.
 */
@Controller()
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get('status')
  async page() {
    return this.status.page();
  }

  @Post('admin/incidents')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async open(@Req() request: RequestWithUser, @Body() body: OpenIncidentDto) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    try {
      const incident = await this.status.open({ ...body, postedBy: user.userId });
      return { id: incident.id, state: incident.state };
    } catch (error) {
      if (error instanceof StatusError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Post('admin/incidents/:id/updates')
  @UseGuards(JwtGuard, RolesGuard)
  @Roles('admin')
  async update(
    @Req() request: RequestWithUser,
    @Param('id') incidentId: string,
    @Body() body: IncidentUpdateDto,
  ) {
    const user = request.user;
    if (user === undefined) throw new BadRequestException('no authenticated user');
    try {
      const incident = await this.status.update({
        incidentId,
        state: body.state,
        body: body.body,
        postedBy: user.userId,
      });
      return { id: incident.id, state: incident.state };
    } catch (error) {
      if (error instanceof StatusError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
