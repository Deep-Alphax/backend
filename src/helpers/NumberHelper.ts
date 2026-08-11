export function getRandomIntegerInclusive(min: number, max: number) {
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
