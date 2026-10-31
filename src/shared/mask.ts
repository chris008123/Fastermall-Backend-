/** 0241234567 -> 024****567 */
export function maskNumber(number: string) {
  return `${number.slice(0, 3)}****${number.slice(-3)}`;
}
