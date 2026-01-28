import loop from "./loop";

export const run = async () => {
  console.log('Coder Demo Core is running...');

  const prompt = `阅读当前目录下 README.md 文件的内容，并用中文写入当前目录的 README-zh.md 文件中`;

  const result = await loop(prompt);

  console.log(`Coder Demo Core is running with result: ${result}`);

}