import { BadRequestException } from '@nestjs/common';

/**
 * Customisable food items (requirement 2.12A), e.g. Gɔbɛ: pick a beans
 * portion (GH₵5 or GH₵7), optionally plantain (GH₵5 or GH₵6), and extras
 * (sausage, egg). The price is always worked out here from the stored
 * option prices, never taken from the app.
 *
 * Rules for each group: the number of DIFFERENT options picked must be
 * between minSelect and maxSelect (minSelect 0 = optional). Each option can
 * be taken 1..maxQuantity times (e.g. 2 eggs); that counts as one pick.
 */

export interface OptionChoice {
  optionId: string;
  quantity?: number;
}

type Money = { toString(): string } | number | string;

export interface PricedOption {
  id: string;
  name: string;
  price: Money;
  maxQuantity: number;
  isAvailable: boolean;
  sortOrder: number;
}

export interface PricedGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  sortOrder: number;
  options: PricedOption[];
}

export interface CustomisableItem {
  id: string;
  name: string;
  price: Money;
  optionGroups?: PricedGroup[];
}

export interface SelectedOption {
  groupId: string;
  groupName: string;
  optionId: string;
  name: string;
  price: number;
  quantity: number;
}

/** GH₵ to whole pesewas, so sums have no float drift. */
const pesewas = (m: Money) => Math.round(Number(m.toString()) * 100);

const invalid = (message: string, code = 'INVALID_OPTIONS') => new BadRequestException({ message, code });

/**
 * The price of one unit of `item` with these choices, and the snapshot to
 * store on the order line. Throws a 400 explaining what is wrong.
 */
export function priceWithOptions(item: CustomisableItem, choices: OptionChoice[] = []) {
  const groups = [...(item.optionGroups ?? [])].sort((a, b) => a.sortOrder - b.sortOrder);
  const byOption = new Map<string, { group: PricedGroup; option: PricedOption }>();
  for (const group of groups) for (const option of group.options) byOption.set(option.id, { group, option });

  const seen = new Set<string>();
  const picked = new Map<string, { option: PricedOption; quantity: number }[]>();

  for (const choice of choices) {
    const quantity = choice.quantity ?? 1;
    const found = byOption.get(choice.optionId);
    if (!found) throw invalid(`That option is not part of ${item.name}`);
    if (seen.has(choice.optionId)) throw invalid(`${found.option.name} is listed twice; use quantity instead`);
    seen.add(choice.optionId);
    if (!found.option.isAvailable) throw invalid(`${found.option.name} is not available right now`, 'OPTION_UNAVAILABLE');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > found.option.maxQuantity) {
      throw invalid(`You can have 1 to ${found.option.maxQuantity} of ${found.option.name}`);
    }
    const list = picked.get(found.group.id) ?? [];
    list.push({ option: found.option, quantity });
    picked.set(found.group.id, list);
  }

  let total = pesewas(item.price);
  const selected: SelectedOption[] = [];

  for (const group of groups) {
    const list = (picked.get(group.id) ?? []).sort((a, b) => a.option.sortOrder - b.option.sortOrder);
    if (list.length < group.minSelect) {
      throw invalid(
        group.minSelect === 1
          ? `Choose ${group.name} for ${item.name}`
          : `Choose at least ${group.minSelect} for ${group.name} (${item.name})`,
        'OPTIONS_REQUIRED',
      );
    }
    if (list.length > group.maxSelect) {
      throw invalid(`Choose at most ${group.maxSelect} for ${group.name} (${item.name})`);
    }
    for (const { option, quantity } of list) {
      total += pesewas(option.price) * quantity;
      selected.push({
        groupId: group.id,
        groupName: group.name,
        optionId: option.id,
        name: option.name,
        price: pesewas(option.price) / 100,
        quantity,
      });
    }
  }

  return { unitPrice: total / 100, selectedOptions: selected.length ? selected : null };
}

/**
 * Identifies "the same thing" in a cart: the item plus its exact choices.
 * Two lines with the same key are merged; different choices stay apart.
 */
export function lineKey(menuItemId: string, choices: OptionChoice[] = []) {
  const parts = choices
    .map((c) => `${c.optionId}x${c.quantity ?? 1}`)
    .sort()
    .join(',');
  return parts ? `${menuItemId}|${parts}` : menuItemId;
}
