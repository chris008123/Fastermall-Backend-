import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MarketplaceService } from './marketplace.service';
import { ListProductsQueryDto } from './dto/list-products-query.dto';

function setup() {
  const prisma: any = {
    product: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
    },
  };
  return { svc: new MarketplaceService(prisma), prisma };
}

// Same conversion the global ValidationPipe does (transform: true).
const parse = (query: Record<string, string>) => {
  const dto = plainToInstance(ListProductsQueryDto, query);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }) };
};

describe('GET /marketplace/products query', () => {
  it('converts query-string values', () => {
    const { dto, errors } = parse({ page: '2', pageSize: '50', minPrice: '5', maxPrice: '20.5', inStock: 'true', sort: 'price_asc' });
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ page: 2, pageSize: 50, minPrice: 5, maxPrice: 20.5, inStock: true, sort: 'price_asc' });
  });

  it('still accepts a large pageSize (capped later, as before)', () => {
    expect(parse({ pageSize: '2000' }).errors).toHaveLength(0);
  });

  it.each([
    [{ sort: 'cheapest' }],
    [{ minPrice: 'abc' }],
    [{ inStock: 'yes' }],
    [{ minRating: '6' }],
    [{ minRating: '0' }],
  ])('rejects %j', (query) => {
    expect(parse(query as any).errors).not.toHaveLength(0);
  });
});

describe('MarketplaceService.findAllProducts', () => {
  it('filters by price range and stock and includes the vendor name', async () => {
    const { svc, prisma } = setup();
    await svc.findAllProducts({ minPrice: 5, maxPrice: 20, inStock: true });
    const args = prisma.product.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ price: { gte: 5, lte: 20 }, stock: { gt: 0 } });
    expect(args.include.vendor).toEqual({ select: { id: true, name: true } });
    expect(prisma.product.count.mock.calls[0][0].where).toEqual(args.where);
  });

  it('adds no price or stock filter when none is asked for', async () => {
    const { svc, prisma } = setup();
    await svc.findAllProducts({});
    const where = prisma.product.findMany.mock.calls[0][0].where;
    expect(where.price).toBeUndefined();
    expect(where.stock).toBeUndefined();
  });

  it.each([
    [undefined, { createdAt: 'desc' }],
    ['relevance', { createdAt: 'desc' }],
    ['price_asc', { price: 'asc' }],
    ['price_desc', { price: 'desc' }],
    ['popular', { orderItems: { _count: 'desc' } }],
    ['rating', { rating: { sort: 'desc', nulls: 'last' } }],
  ])('sort=%s orders by %j', async (sort, first) => {
    const { svc, prisma } = setup();
    await svc.findAllProducts({ sort: sort as any });
    const orderBy = prisma.product.findMany.mock.calls[0][0].orderBy;
    expect(orderBy[0]).toEqual(first);
    expect(orderBy[orderBy.length - 1]).toEqual({ id: 'asc' }); // stable paging
  });

  it('minRating keeps only products rated at least that (unrated ones drop out)', async () => {
    const { svc, prisma } = setup();
    await svc.findAllProducts({ minRating: 4 });
    expect(prisma.product.findMany.mock.calls[0][0].where.rating).toEqual({ gte: 4 });
    expect(parse({ minRating: '4.5' }).errors).toHaveLength(0);
  });

  it('rejects minPrice above maxPrice', async () => {
    await expect(setup().svc.findAllProducts({ minPrice: 30, maxPrice: 10 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('includes the vendor on a single product', async () => {
    const { svc, prisma } = setup();
    await svc.findOneProduct('p1');
    expect(prisma.product.findUnique.mock.calls[0][0].include.vendor).toEqual({ select: { id: true, name: true } });
  });
});
