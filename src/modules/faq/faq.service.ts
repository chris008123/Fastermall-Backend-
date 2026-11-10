import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CreateFaqDto, UpdateFaqDto } from './dto/faq.dto';

// Category first (uncategorised last), then the admin's order, then oldest
// first so ties keep a stable order.
const FAQ_ORDER: Prisma.FaqOrderByWithRelationInput[] = [
  { category: { sort: 'asc', nulls: 'last' } },
  { sortOrder: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

const PUBLIC_SELECT = {
  id: true,
  question: true,
  answer: true,
  category: true,
  sortOrder: true,
  updatedAt: true,
} satisfies Prisma.FaqSelect;

/**
 * Frequently Asked Questions about Fastermall, so customers can find answers
 * without contacting management. Admins write them; the apps read the
 * published ones.
 */
@Injectable()
export class FaqService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Published questions, in display order. Also grouped by category, so the
   * app can show sections without sorting them itself.
   */
  async listPublished(category?: string) {
    const items = await this.prisma.faq.findMany({
      where: { isPublished: true, ...(category ? { category } : {}) },
      orderBy: FAQ_ORDER,
      select: PUBLIC_SELECT,
    });

    const groups = new Map<string | null, typeof items>();
    for (const item of items) {
      const list = groups.get(item.category) ?? [];
      list.push(item);
      groups.set(item.category, list);
    }

    return {
      items,
      categories: [...groups.entries()].map(([name, faqs]) => ({ name, items: faqs })),
    };
  }

  /** Admin: every question, published or not. */
  listAll() {
    return this.prisma.faq.findMany({ orderBy: FAQ_ORDER });
  }

  create(dto: CreateFaqDto) {
    return this.prisma.faq.create({
      data: {
        question: dto.question,
        answer: dto.answer,
        category: dto.category || null,
        sortOrder: dto.sortOrder ?? 0,
        isPublished: dto.isPublished ?? true,
      },
    });
  }

  async update(id: string, dto: UpdateFaqDto) {
    const data: Prisma.FaqUpdateInput = {};
    if (dto.question !== undefined) data.question = dto.question;
    if (dto.answer !== undefined) data.answer = dto.answer;
    if (dto.category !== undefined) data.category = dto.category || null;
    if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder;
    if (dto.isPublished !== undefined) data.isPublished = dto.isPublished;
    if (Object.keys(data).length === 0) throw new BadRequestException('Nothing to update');

    try {
      return await this.prisma.faq.update({ where: { id }, data });
    } catch (e) {
      throw this.notFound(e);
    }
  }

  async remove(id: string) {
    try {
      await this.prisma.faq.delete({ where: { id } });
    } catch (e) {
      throw this.notFound(e);
    }
    return { deleted: true };
  }

  private notFound(e: unknown) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2025') {
      return new NotFoundException('FAQ not found');
    }
    return e;
  }
}
