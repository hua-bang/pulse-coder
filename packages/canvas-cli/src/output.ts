export type OutputFormat = 'json' | 'text';

export function output(data: unknown, format: OutputFormat, textFn: (d: unknown) => string): void {
  if (format === 'json') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(textFn(data));
  }
}

export function errorOutput(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}
