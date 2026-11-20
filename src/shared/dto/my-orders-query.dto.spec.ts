import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MyOrdersQueryDto } from './my-orders-query.dto';

const check = (query: Record<string, string>) => {
  const dto = plainToInstance(MyOrdersQueryDto, query);
  return { dto, errors: validateSync(dto) };
};

describe('MyOrdersQueryDto', () => {
  it('accepts no parameters (every order, as before)', () => {
    expect(check({}).errors).toHaveLength(0);
  });

  it('turns take into a number and accepts a type', () => {
    const { dto, errors } = check({ take: '13', type: 'FOOD' });
    expect(errors).toHaveLength(0);
    expect(dto.take).toBe(13);
    expect(dto.type).toBe('FOOD');
  });

  it.each([['0'], ['101'], ['abc'], ['2.5']])('rejects take=%s', (take) => {
    expect(check({ take }).errors).not.toHaveLength(0);
  });

  it('rejects an unknown type', () => {
    expect(check({ type: 'LAUNDRY' }).errors).not.toHaveLength(0);
  });
});
