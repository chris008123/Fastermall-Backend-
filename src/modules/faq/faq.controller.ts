import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { StaffRole } from '@prisma/client';
import { FaqService } from './faq.service';
import { CreateFaqDto, FaqQueryDto, UpdateFaqDto } from './dto/faq.dto';
import { JwtAuthGuard } from '../../shared/guards/jwt-auth.guard';
import { RolesGuard } from '../../shared/guards/roles.guard';
import { Roles } from '../../shared/decorators/roles.decorator';

// Public: the apps show these before and after sign-in.
@Controller('faqs')
export class FaqController {
  constructor(private readonly faqs: FaqService) {}

  // Answers change rarely; a short cache keeps the help screen fast.
  @Header('Cache-Control', 'public, max-age=300')
  @Get()
  list(@Query() q: FaqQueryDto) {
    return this.faqs.listPublished(q.category);
  }
}

// Admin console. Writes are recorded by the audit log automatically.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(StaffRole.ADMIN)
@Controller('admin/faqs')
export class AdminFaqController {
  constructor(private readonly faqs: FaqService) {}

  @Get()
  listAll() {
    return this.faqs.listAll();
  }

  @Post()
  create(@Body() dto: CreateFaqDto) {
    return this.faqs.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateFaqDto) {
    return this.faqs.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.faqs.remove(id);
  }
}
