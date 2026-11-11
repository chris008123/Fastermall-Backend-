import { BadRequestException } from '@nestjs/common';
import { CustomisableItem, lineKey, priceWithOptions } from './menu-options';

// The requirement's Gɔbɛ example: base 0, beans GH₵5 or GH₵7 (pick one),
// plantain GH₵5 or GH₵6 (optional), extras sausage/egg (up to 2 kinds,
// up to 3 eggs).
const gobe: CustomisableItem = {
  id: 'gobe',
  name: 'Gɔbɛ',
  price: '0.00',
  optionGroups: [
    {
      id: 'extras', name: 'Extras', minSelect: 0, maxSelect: 2, sortOrder: 2,
      options: [
        { id: 'sausage', name: 'Sausage', price: '3.50', maxQuantity: 2, isAvailable: true, sortOrder: 0 },
        { id: 'egg', name: 'Egg', price: '2.00', maxQuantity: 3, isAvailable: true, sortOrder: 1 },
        { id: 'fish', name: 'Fish', price: '6.00', maxQuantity: 1, isAvailable: false, sortOrder: 2 },
      ],
    },
    {
      id: 'beans', name: 'Beans portion', minSelect: 1, maxSelect: 1, sortOrder: 0,
      options: [
        { id: 'beans5', name: 'Beans (GH₵5)', price: '5.00', maxQuantity: 1, isAvailable: true, sortOrder: 0 },
        { id: 'beans7', name: 'Beans (GH₵7)', price: '7.00', maxQuantity: 1, isAvailable: true, sortOrder: 1 },
      ],
    },
    {
      id: 'plantain', name: 'Plantain', minSelect: 0, maxSelect: 1, sortOrder: 1,
      options: [
        { id: 'plantain5', name: 'Plantain (GH₵5)', price: '5.00', maxQuantity: 1, isAvailable: true, sortOrder: 0 },
        { id: 'plantain6', name: 'Plantain (GH₵6)', price: '6.00', maxQuantity: 1, isAvailable: true, sortOrder: 1 },
      ],
    },
  ],
};

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as { code: string; message: string };
  }
  throw new Error('expected a 400');
};

describe('priceWithOptions — the Gɔbɛ example', () => {
  it('customer 1: beans GH₵5 + plantain GH₵5 + sausage = GH₵13.50', () => {
    const out = priceWithOptions(gobe, [{ optionId: 'sausage' }, { optionId: 'plantain5' }, { optionId: 'beans5' }]);
    expect(out.unitPrice).toBe(13.5);
    // Snapshot in the menu's order (beans, plantain, extras), whatever order the app sent.
    expect(out.selectedOptions).toEqual([
      { groupId: 'beans', groupName: 'Beans portion', optionId: 'beans5', name: 'Beans (GH₵5)', price: 5, quantity: 1 },
      { groupId: 'plantain', groupName: 'Plantain', optionId: 'plantain5', name: 'Plantain (GH₵5)', price: 5, quantity: 1 },
      { groupId: 'extras', groupName: 'Extras', optionId: 'sausage', name: 'Sausage', price: 3.5, quantity: 1 },
    ]);
  });

  it('customer 2: beans GH₵7 + plantain GH₵6 + egg = GH₵15', () => {
    expect(priceWithOptions(gobe, [{ optionId: 'beans7' }, { optionId: 'plantain6' }, { optionId: 'egg' }]).unitPrice).toBe(15);
  });

  it('quantities multiply (3 eggs) and count as one pick', () => {
    const out = priceWithOptions(gobe, [{ optionId: 'beans5' }, { optionId: 'egg', quantity: 3 }, { optionId: 'sausage', quantity: 2 }]);
    expect(out.unitPrice).toBe(5 + 6 + 7);
  });

  it('optional groups can be skipped; no float drift', () => {
    const item = { ...gobe, price: '0.10', optionGroups: [{ ...gobe.optionGroups![1], options: [{ ...gobe.optionGroups![1].options[0], price: '0.20' }] }] };
    expect(priceWithOptions(item, [{ optionId: 'beans5' }]).unitPrice).toBe(0.3);
  });
});

describe('priceWithOptions — refusals', () => {
  it('a required group must be chosen', () => {
    expect(code(() => priceWithOptions(gobe, [{ optionId: 'plantain5' }]))).toMatchObject({ code: 'OPTIONS_REQUIRED', message: 'Choose Beans portion for Gɔbɛ' });
    expect(code(() => priceWithOptions(gobe, []))).toMatchObject({ code: 'OPTIONS_REQUIRED' });
  });

  it('too many picks in a group', () => {
    expect(code(() => priceWithOptions(gobe, [{ optionId: 'beans5' }, { optionId: 'beans7' }])).message).toMatch(/at most 1 for Beans portion/);
  });

  it('an option from another item, a duplicate, an unavailable one, or a bad quantity', () => {
    expect(code(() => priceWithOptions(gobe, [{ optionId: 'beans5' }, { optionId: 'jollof-large' }])).code).toBe('INVALID_OPTIONS');
    expect(code(() => priceWithOptions(gobe, [{ optionId: 'beans5' }, { optionId: 'egg' }, { optionId: 'egg' }])).message).toMatch(/twice/);
    expect(code(() => priceWithOptions(gobe, [{ optionId: 'beans5' }, { optionId: 'fish' }])).code).toBe('OPTION_UNAVAILABLE');
    expect(code(() => priceWithOptions(gobe, [{ optionId: 'beans5' }, { optionId: 'egg', quantity: 4 }])).message).toMatch(/1 to 3 of Egg/);
    expect(code(() => priceWithOptions(gobe, [{ optionId: 'beans5', quantity: 0 }])).code).toBe('INVALID_OPTIONS');
  });

  it('a plain item takes no options and keeps its own price', () => {
    const plain = { id: 'water', name: 'Water', price: '2.50' };
    expect(priceWithOptions(plain)).toEqual({ unitPrice: 2.5, selectedOptions: null });
    expect(code(() => priceWithOptions(plain, [{ optionId: 'beans5' }])).code).toBe('INVALID_OPTIONS');
  });
});

describe('lineKey', () => {
  it('same item and same choices in any order are one line; different choices are two', () => {
    expect(lineKey('gobe', [{ optionId: 'egg' }, { optionId: 'beans5' }])).toBe(lineKey('gobe', [{ optionId: 'beans5' }, { optionId: 'egg', quantity: 1 }]));
    expect(lineKey('gobe', [{ optionId: 'beans5' }])).not.toBe(lineKey('gobe', [{ optionId: 'beans7' }]));
    expect(lineKey('gobe', [{ optionId: 'egg', quantity: 2 }])).not.toBe(lineKey('gobe', [{ optionId: 'egg' }]));
    expect(lineKey('water')).toBe('water');
  });
});
