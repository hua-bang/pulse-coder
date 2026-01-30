import loop from "./loop";

export const run = async () => {
  console.log('Coder Demo Core is running...');

  const prompt = `帮我在当前目录新建一个文件夹叫 snake-3d，写一个 3D 贪吃蛇游戏，需要用 React + TS + Vite 来实现，并且要有良好的代码结构和注释说明。完成后，生成一个 README.md 文件，介绍如何运行和使用这个游戏。`;

  const result = await loop(prompt, {
    onResult: (result) => {
      console.log(`Step: ${JSON.stringify(result)} \n\n\n\n`);
    },
  });

  console.log(`Coder Demo Core is running with result: ${result}`);
}