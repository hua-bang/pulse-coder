import loop from "./loop";
import type { Context } from "./typings";

export const run = async () => {
  console.log('Coder Demo Core is running...');

  const context: Context = {
    messages: [],
  };


  const result = await loop(context, {
    onResult: (result) => {
      console.log(`Step: ${JSON.stringify(result)} \n\n\n\n`);
    },
  });

  console.log(`Coder Demo Core is running with result: ${result}`);
}