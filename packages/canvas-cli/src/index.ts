import { createCli } from './cli';

createCli().parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
