export const CONSOLE_COLORS = {
  black: 30,
  gray: 90,
  red: 31,
  green: 32,
  yellow: 33,
  magenta: 35,
  cyan: 36,
} as const;

export function displayAsTableRow(
  pref: string,
  value: string,
  distance: number,
  color: number = 0
): void {
  const len = pref.length;
  let text = pref + ' \x1b[' + color + 'm';
  for (let i = 0; i < distance - len; i++) {
    text += '_';
  }
  text += ' ' + value + '\x1b[0m';
  console.log(text);
}

export function display(text: string, color: number = 0): void {
  console.log('\x1b[' + color + 'm' + text + '\x1b[0m');
}

export function error(text: string): void {
  display(text, CONSOLE_COLORS.red);
}
