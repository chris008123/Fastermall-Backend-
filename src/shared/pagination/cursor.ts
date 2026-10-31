import { BadRequestException } from '@nestjs/common';

// A cursor marks "the last row you saw" as (createdAt, id). Rows are always
// ordered by those two fields, so paging never skips or repeats a row, even
// when several rows share the same createdAt.

export function encodeCursor(at: Date, id: string) {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
    const at = new Date(iso);
    if (!id || Number.isNaN(at.getTime())) throw new Error();
    return { at, id };
  } catch {
    throw new BadRequestException({ message: 'Invalid cursor', code: 'INVALID_CURSOR' });
  }
}

/** Prisma `where` that continues after the cursor row. */
export function afterCursor(cursor: string, direction: 'asc' | 'desc') {
  const { at, id } = decodeCursor(cursor);
  const op = direction === 'desc' ? 'lt' : 'gt';
  return {
    OR: [{ createdAt: { [op]: at } }, { createdAt: at, id: { [op]: id } }],
  };
}

/** Rows fetched with take = limit + 1 -> one page plus the cursor for the next. */
export function toPage<T extends { createdAt: Date; id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
