import loop from "./loop";

export const run = async () => {
  console.log('Coder Demo Core is running...');

  const prompt = `帮我把当前目录的贪吃蛇小游戏项目用 Vite + React + TypeScript 重写一遍，项目结构要清晰，并且包含必要的注释说明。`;

  const result = await loop(prompt, {
    onResult: (result) => {
      console.log('Coder Demo Core is running with result:', JSON.stringify(result));
    },
  });

  console.log(`Coder Demo Core is running with result: ${result}`);

}